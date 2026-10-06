# Remote state: versioned, encrypted, private, TLS-only. S3-native locking.
terraform {
  backend "s3" {
    bucket       = "razekit-dev-tfstate-074189217970"
    key          = "dev-runtime/terraform.tfstate"
    region       = "us-east-2"
    encrypt      = true
    use_lockfile = true
  }
}
