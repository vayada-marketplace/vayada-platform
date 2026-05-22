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
    key            = "infra/terraform.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "vayada-terraform-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region
}
