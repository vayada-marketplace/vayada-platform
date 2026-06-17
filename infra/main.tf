terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }

  # After cloning this repo for the first time, run:
  #   terraform init -migrate-state
  # to copy state from the legacy key (infra/terraform.tfstate) to platform/terraform.tfstate.
  # Do not run terraform apply until the plan shows no changes after migration.
  backend "s3" {
    bucket         = "vayada-terraform-state"
    key            = "platform/terraform.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "vayada-terraform-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
