terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "RazeKit"
      Product   = "RazeKitDEV"
      Component = "build-runtime"
      ManagedBy = "terraform"
    }
  }
}
