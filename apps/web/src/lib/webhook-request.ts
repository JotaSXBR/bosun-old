export type WebhookRequest = {
  rawBody: string;
  headers: Record<string, string>;
  query: Record<string, string>;
};

/** Raw body (needed for signature checks) plus lower-cased headers and query of a webhook call. */
export async function readWebhookRequest(request: Request): Promise<WebhookRequest> {
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const query: Record<string, string> = {};
  new URL(request.url).searchParams.forEach((value, key) => {
    query[key] = value;
  });
  return { rawBody, headers, query };
}
