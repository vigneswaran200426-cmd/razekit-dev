#!/bin/bash
# Creates the RazeKit DEV control plane in us-east-2. Idempotent: re-running
# skips what exists. Run from AWS CloudShell, signed in as the account owner:
#
#   ADMIN_EMAIL=you@example.com BUDGET_USD=40 REPO_REF=main bash provision.sh
#
# Creates: EBS encryption by default, the AWS Budget with email alerts, the
# control-plane IAM role + instance profile, a security group with no inbound
# rules, and one t3.small instance. Creates no GPU instance and deletes nothing.
set -euo pipefail

EXPECTED_ACCOUNT=074189217970
REGION=us-east-2
NAME=razekit-dev-control-plane
ADMIN_EMAIL="${ADMIN_EMAIL:?ADMIN_EMAIL is required}"
BUDGET_USD="${BUDGET_USD:-40}"
REPO_REF="${REPO_REF:-main}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
RAW="https://raw.githubusercontent.com/vigneswaran200426-cmd/razekit-dev/${REPO_REF}/infra/aws/control-plane"
export AWS_DEFAULT_REGION=$REGION

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCOUNT" = "$EXPECTED_ACCOUNT" ] || { echo "STOP: account is $ACCOUNT, expected $EXPECTED_ACCOUNT"; exit 1; }
echo "account ok: $ACCOUNT $REGION"

# 1. Encryption by default for every new EBS volume in the region.
aws ec2 enable-ebs-encryption-by-default --query EbsEncryptionByDefault --output text | sed 's/^/ebs-encryption-by-default: /'

# 2. Budget with alerts at 50/80/100 % actual and 100 % forecast.
if aws budgets describe-budget --account-id "$ACCOUNT" --budget-name razekit-dev-monthly >/dev/null 2>&1; then
  echo "budget: exists"
else
  sub="\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$ADMIN_EMAIL\"}]"
  n() { echo "{\"Notification\":{\"NotificationType\":\"$1\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":$2,\"ThresholdType\":\"PERCENTAGE\"},$sub}"; }
  aws budgets create-budget --account-id "$ACCOUNT" \
    --budget "{\"BudgetName\":\"razekit-dev-monthly\",\"BudgetType\":\"COST\",\"TimeUnit\":\"MONTHLY\",\"BudgetLimit\":{\"Amount\":\"$BUDGET_USD\",\"Unit\":\"USD\"},\"CostTypes\":{\"IncludeCredit\":false,\"IncludeRefund\":false,\"IncludeTax\":true,\"IncludeSubscription\":true,\"UseBlended\":false}}" \
    --notifications-with-subscribers "[$(n ACTUAL 50),$(n ACTUAL 80),$(n ACTUAL 100),$(n FORECASTED 100)]"
  echo "budget: created razekit-dev-monthly \$$BUDGET_USD"
fi

# 3. Instance role: Session Manager + the gateway's narrow EC2/Budgets/SES rights.
if ! aws iam get-role --role-name "$NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$NAME" --description "RazeKit DEV control plane (System A, System B, inference gateway)" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --tags Key=Project,Value=razekit-dev >/dev/null
  echo "role: created"
else
  echo "role: exists"
fi
aws iam attach-role-policy --role-name "$NAME" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
curl -fsSL "$RAW/iam/control-plane-role-policy.json" | sed "s/\${AWS_ACCOUNT_ID}/$ACCOUNT/g" > /tmp/rk-policy.json
aws iam put-role-policy --role-name "$NAME" --policy-name razekit-dev-gateway --policy-document file:///tmp/rk-policy.json
if ! aws iam get-instance-profile --instance-profile-name "$NAME" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$NAME" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$NAME" --role-name "$NAME"
  echo "instance profile: created; waiting for IAM propagation"
  sleep 15
else
  echo "instance profile: exists"
fi

# 4. Security group: no inbound at all; egress HTTPS, HTTP (package mirrors) and Postgres (Neon).
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name "$NAME" --description "RazeKit DEV control plane: no inbound" --vpc-id "$VPC" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=razekit-dev}]" --query GroupId --output text)
  aws ec2 revoke-security-group-egress --group-id "$SG" --ip-permissions '[{"IpProtocol":"-1","IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]' >/dev/null
  aws ec2 authorize-security-group-egress --group-id "$SG" --ip-permissions \
    '[{"IpProtocol":"tcp","FromPort":443,"ToPort":443,"IpRanges":[{"CidrIp":"0.0.0.0/0"}]},{"IpProtocol":"tcp","FromPort":80,"ToPort":80,"IpRanges":[{"CidrIp":"0.0.0.0/0"}]},{"IpProtocol":"tcp","FromPort":5432,"ToPort":5432,"IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]' >/dev/null
  echo "security group: created $SG (no inbound)"
else
  echo "security group: exists $SG"
fi

# 5. The instance.
EXISTING=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "$EXISTING" ]; then
  echo "instance: exists $EXISTING"
  ID=$EXISTING
else
  AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
  { echo '#!/bin/bash'; echo "export REPO_REF='$REPO_REF' ADMIN_EMAIL='$ADMIN_EMAIL'"; curl -fsSL "$RAW/control-plane-user-data.sh" | tail -n +2; } > /tmp/rk-user-data.sh
  ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
    --iam-instance-profile Name="$NAME" --security-group-ids "$SG" \
    --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3","Encrypted":true,"DeleteOnTermination":true}}]' \
    --credit-specification CpuCredits=standard \
    --user-data file:///tmp/rk-user-data.sh \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=Project,Value=razekit-dev},{Key=razekit:role,Value=control-plane}]" "ResourceType=volume,Tags=[{Key=Project,Value=razekit-dev}]" \
    --query 'Instances[0].InstanceId' --output text)
  echo "instance: launched $ID ($INSTANCE_TYPE, $AMI)"
fi
aws ec2 wait instance-running --instance-ids "$ID"
aws ec2 describe-instances --instance-ids "$ID" --query 'Reservations[0].Instances[0].[InstanceId,InstanceType,State.Name,PrivateIpAddress,PublicIpAddress,MetadataOptions.HttpTokens,IamInstanceProfile.Arn]' --output text
echo "PROVISION_DONE $ID"
