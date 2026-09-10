import { requireTrue } from "./migration-rehearsal-reader-contract.mjs";

export const expectedTaskImages = Object.freeze({
  "controller-api":
    "sha256:fab6bafdd04009d5807b9e9362b2c0e0974e15077592343a02d23f18f27c8689",
  frontend:
    "sha256:471b755e8596adde20bc87951bb8eed682d2d3265280ba0a7a8a48cfa81ae59b",
  browser:
    "sha256:83192064c7510f7ee73dd63dc5f22a5e01a92c81a2e6a9c715d9e3fe55471fd9",
});

export async function attestTaskRuntime(fetchMetadata, env) {
  const base = env.ECS_CONTAINER_METADATA_URI_V4;
  requireTrue(
    /^http:\/\/169\.254\.170\.2\/v4\/[A-Za-z0-9-]+$/.test(base ?? ""),
    "ECS_METADATA_URI",
  );
  const response = await fetchMetadata(`${base}/task`, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  requireTrue(response.status === 200, "ECS_METADATA_STATUS");
  const metadata = await response.json();
  requireTrue(
    /^arn:aws:ecs:eu-west-1:269416271598:task\/vayada-backend-cluster\/[0-9a-f]{32}$/.test(
      metadata?.TaskARN ?? "",
    ),
    "ECS_TASK_ARN",
  );
  requireTrue(Array.isArray(metadata?.Containers), "ECS_METADATA_CONTAINERS");
  const images = {};
  for (const [name, expected] of Object.entries(expectedTaskImages)) {
    const matches = metadata.Containers.filter(
      (container) => container?.Name === name,
    );
    requireTrue(
      matches.length === 1 && matches[0].ImageID === expected,
      "ECS_IMAGE_DIGEST_" + name.replaceAll("-", "_").toUpperCase(),
    );
    images[name] = matches[0].ImageID;
  }
  return { taskArn: metadata.TaskARN, images };
}
