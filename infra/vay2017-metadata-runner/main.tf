terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "vayada-terraform-state"
    key            = "vay2017/metadata-runner/terraform.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "vayada-terraform-lock"
    encrypt        = true
  }
}

provider "aws" {
  region              = local.vay2017_rehearsal_region
  allowed_account_ids = [local.vay2017_rehearsal_account_id]
}
