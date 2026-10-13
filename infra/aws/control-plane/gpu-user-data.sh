#!/bin/bash
# RazeKit DEV GPU inference instance — EC2 user data.
# AMI: an AWS Deep Learning Base GPU AMI (Ubuntu 22.04/24.04), which ships the
# NVIDIA driver. Instance: one 24 GB GPU (g6.xlarge, NVIDIA L4; or g5.xlarge,
# NVIDIA A10G).
#
# Ollama listens on the instance's PRIVATE address only, and its security
# group admits port 11434 from the control plane's security group only. The
# model store lives on the encrypted data volume, so stopping the instance —
# which the gateway does after an idle period — keeps the weights.
set -euo pipefail

MODEL_DEVICE="${MODEL_DEVICE:-/dev/nvme1n1}"
MODEL_DIR=/var/lib/ollama

if ! blkid "$MODEL_DEVICE" >/dev/null 2>&1; then mkfs -t xfs "$MODEL_DEVICE"; fi
mkdir -p "$MODEL_DIR"
grep -q "$MODEL_DIR" /etc/fstab || echo "UUID=$(blkid -s UUID -o value "$MODEL_DEVICE") $MODEL_DIR xfs defaults,nofail 0 2" >> /etc/fstab
mount -a

curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh
sh /tmp/ollama-install.sh
chown -R ollama:ollama "$MODEL_DIR"

TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H "x-aws-ec2-metadata-token-ttl-seconds: 300")
PRIVATE_IP=$(curl -s -H "x-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)

mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/razekit.conf <<EOF
[Service]
Environment="OLLAMA_HOST=${PRIVATE_IP}:11434"
Environment="OLLAMA_MODELS=${MODEL_DIR}/models"
# A 24 GB GPU cannot hold qwen3-coder:30b and gpt-oss:20b together.
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_CONTEXT_LENGTH=16384"
Environment="OLLAMA_KEEP_ALIVE=10m"
EOF
systemctl daemon-reload
systemctl enable --now ollama
sleep 5

# The approved assignments, exactly. No substitution.
export OLLAMA_HOST="${PRIVATE_IP}:11434"
ollama pull qwen3-coder:30b
ollama pull gpt-oss:20b
ollama list
nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv
