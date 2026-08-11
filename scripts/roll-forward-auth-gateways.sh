#!/usr/bin/env bash

set -euo pipefail

cluster="${ECS_CLUSTER:-vayada-backend-cluster}"
region="${AWS_REGION:-eu-west-1}"
contract_file="infra/auth-gateways.json"
summary_file="${GITHUB_STEP_SUMMARY:-/dev/null}"
task_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/auth-gateway-roll-forward.XXXXXX")"
trap 'rm -r "$task_dir"' EXIT

service_task_definition() {
  aws ecs describe-services \
    --cluster "$cluster" \
    --services "$service_name" \
    --region "$region" \
    --query 'services[?status==`ACTIVE`].taskDefinition | [0]' \
    --output text
}

while IFS= read -r service_key; do
  task_family="vayada-${service_key}"
  service_name="${task_family}-service"
  container_name="$task_family"
  current_task_definition="$(service_task_definition)"
  latest_task_definition="$(
    aws ecs describe-task-definition \
      --task-definition "$task_family" \
      --region "$region" \
      --query 'taskDefinition.taskDefinitionArn' \
      --output text
  )"

  if [ -z "$current_task_definition" ] || [ "$current_task_definition" = "None" ]; then
    echo "::error::No active ECS task definition found for ${service_name}."
    exit 1
  fi
  if [ -z "$latest_task_definition" ] || [ "$latest_task_definition" = "None" ]; then
    echo "::error::No latest ECS task definition found for ${task_family}."
    exit 1
  fi
  if [ "$current_task_definition" = "$latest_task_definition" ]; then
    bash scripts/smoke-auth-gateway.sh "$service_key"
    continue
  fi

  current_image="$(
    aws ecs describe-task-definition \
      --task-definition "$current_task_definition" \
      --region "$region" \
      --query "taskDefinition.containerDefinitions[?name=='${container_name}'].image | [0]" \
      --output text
  )"
  if [ -z "$current_image" ] || [ "$current_image" = "None" ]; then
    echo "::error::No active image found for ${container_name}."
    exit 1
  fi

  source_file="${task_dir}/${service_key}-source.json"
  rendered_file="${task_dir}/${service_key}-rendered.json"
  aws ecs describe-task-definition \
    --task-definition "$latest_task_definition" \
    --region "$region" \
    --query taskDefinition \
    --output json > "$source_file"

  if ! jq --exit-status --arg container "$container_name" '
    [.containerDefinitions[] | select(.name == $container)] | length == 1
  ' "$source_file" >/dev/null; then
    echo "::error::Expected exactly one ${container_name} container in ${latest_task_definition}."
    exit 1
  fi

  jq --arg container "$container_name" --arg image "$current_image" '
    del(
      .taskDefinitionArn,
      .revision,
      .status,
      .requiresAttributes,
      .compatibilities,
      .registeredAt,
      .registeredBy,
      .deregisteredAt
    ) |
    .containerDefinitions |= map(
      if .name == $container then .image = $image else . end
    )
  ' "$source_file" > "$rendered_file"

  deployed_task_definition="$(
    aws ecs register-task-definition \
      --cli-input-json "file://${rendered_file}" \
      --region "$region" \
      --query 'taskDefinition.taskDefinitionArn' \
      --output text
  )"

  observed_task_definition="$(service_task_definition)"
  if [ "$observed_task_definition" != "$current_task_definition" ]; then
    echo "::error::${service_name} changed from ${current_task_definition} to ${observed_task_definition} during roll-forward preparation; refusing to overwrite it."
    exit 1
  fi

  roll_forward_failed=false
  if ! aws ecs update-service \
    --cluster "$cluster" \
    --service "$service_name" \
    --task-definition "$deployed_task_definition" \
    --region "$region" >/dev/null; then
    roll_forward_failed=true
  elif ! aws ecs wait services-stable \
      --cluster "$cluster" \
      --services "$service_name" \
      --region "$region"; then
    roll_forward_failed=true
  elif ! bash scripts/smoke-auth-gateway.sh "$service_key"; then
    roll_forward_failed=true
  fi

  if [ "$roll_forward_failed" = true ]; then
    echo "::error::Auth gateway roll-forward failed for ${service_key}; restoring ${current_task_definition}."
    observed_task_definition="$(service_task_definition)"
    if [ "$observed_task_definition" = "$deployed_task_definition" ]; then
      aws ecs update-service \
        --cluster "$cluster" \
        --service "$service_name" \
        --task-definition "$current_task_definition" \
        --region "$region" >/dev/null
    elif [ "$observed_task_definition" != "$current_task_definition" ]; then
      echo "::error::${service_name} advanced to unexpected ${observed_task_definition}; refusing to overwrite it with rollback ${current_task_definition}."
      exit 1
    fi
    aws ecs wait services-stable \
      --cluster "$cluster" \
      --services "$service_name" \
      --region "$region"
    exit 1
  fi

  observed_task_definition="$(service_task_definition)"
  if [ "$observed_task_definition" != "$deployed_task_definition" ]; then
    echo "::error::${service_name} advanced to unexpected ${observed_task_definition} after roll-forward; refusing to overwrite it."
    exit 1
  fi

  printf '%s\n' "- Auth gateway contract roll-forward: ${service_key} deployed ${deployed_task_definition}" >> "$summary_file"
done < <(jq -r '.[].service' "$contract_file")
