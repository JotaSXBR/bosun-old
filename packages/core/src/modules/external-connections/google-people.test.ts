import { describe, expect, it } from "vitest";

import { createGooglePeopleClient, GooglePeopleError } from "./google-people";

type Call = { url: URL; method: string; body: unknown; auth: string | null };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const googleError = (status: number, name: string, message = "boom") =>
  json({ error: { code: status, message, status: name } }, status);

const person = (overrides: Record<string, unknown> = {}) => ({
  resourceName: "people/c123",
  etag: "%etag-person",
  metadata: { sources: [{ type: "CONTACT", id: "123", etag: "etag-1" }] },
  phoneNumbers: [{ value: "+55 11 98888-7777", canonicalForm: "+5511988887777" }],
  emailAddresses: [{ value: "Maria@Example.com" }],
  ...overrides,
});

/** Fake fetch that answers from a queue and records every call. */
function harness(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const client = createGooglePeopleClient({
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        auth: headers.get("authorization"),
      });
      const next = queue.shift();
      if (!next) throw new Error("unexpected extra request");
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
  });
  return { client, calls, sleeps };
}

const token = "access-token";

describe("google people client", () => {
  it("creates a contact with the documented endpoint and returns the normalized person", async () => {
    const { client, calls } = harness([json(person())]);
    const created = await client.createContact({
      accessToken: token,
      person: {
        names: [{ unstructuredName: "Maria" }],
        phoneNumbers: [{ value: "+5511988887777" }],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe(
      "https://people.googleapis.com/v1/people:createContact",
    );
    expect(calls[0]!.url.searchParams.get("personFields")).toBe(
      "metadata,phoneNumbers,emailAddresses",
    );
    expect(calls[0]!.auth).toBe(`Bearer ${token}`);
    expect(calls[0]!.body).toEqual({
      names: [{ unstructuredName: "Maria" }],
      phoneNumbers: [{ value: "+5511988887777" }],
    });
    expect(created).toEqual({
      resourceName: "people/c123",
      source: { type: "CONTACT", id: "123", etag: "etag-1" },
      phones: ["+5511988887777"],
      emails: ["Maria@Example.com"],
    });
  });

  it("gets a contact, and answers null when it no longer exists", async () => {
    const { client, calls } = harness([json(person()), googleError(404, "NOT_FOUND")]);
    const found = await client.getContact({ accessToken: token, resourceName: "people/c123" });
    expect(found?.resourceName).toBe("people/c123");
    expect(calls[0]!.url.pathname).toBe("/v1/people/c123");
    expect(calls[0]!.method).toBe("GET");
    expect(await client.getContact({ accessToken: token, resourceName: "people/c999" })).toBeNull();
  });

  it("updates with the etag source, replacing only the listed fields", async () => {
    const { client, calls } = harness([json(person())]);
    const current = {
      resourceName: "people/c123",
      source: { type: "CONTACT", id: "123", etag: "etag-1" },
      phones: [],
      emails: [],
    };
    await client.updateContact({
      accessToken: token,
      current,
      person: { names: [{ unstructuredName: "Maria Nova" }] },
      fields: ["names"],
    });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url.pathname).toBe("/v1/people/c123:updateContact");
    expect(calls[0]!.url.searchParams.get("updatePersonFields")).toBe("names");
    expect(calls[0]!.body).toEqual({
      names: [{ unstructuredName: "Maria Nova" }],
      metadata: { sources: [{ type: "CONTACT", id: "123", etag: "etag-1" }] },
    });
  });

  it("maps a failedPrecondition (stale etag) to a conflict", async () => {
    const { client } = harness([googleError(400, "FAILED_PRECONDITION", "etag mismatch")]);
    const current = {
      resourceName: "people/c123",
      source: { type: "CONTACT", id: "123", etag: "old" },
      phones: [],
      emails: [],
    };
    await expect(
      client.updateContact({ accessToken: token, current, person: {}, fields: ["names"] }),
    ).rejects.toMatchObject({ name: "GooglePeopleError", code: "conflict", status: 400 });
  });

  it("rejects a resource name that is not people/<id> before any request", async () => {
    const { client, calls } = harness([]);
    await expect(
      client.getContact({ accessToken: token, resourceName: "people/../../oauth2/revoke" }),
    ).rejects.toBeInstanceOf(GooglePeopleError);
    expect(calls).toHaveLength(0);
  });

  it("warms the search cache once with an empty query, then searches by the real query", async () => {
    const { client, calls } = harness([
      json({}),
      json({ results: [{ person: person() }] }),
      json({ results: [] }),
    ]);
    const hits = await client.searchContacts({ accessToken: token, query: "+5511988887777" });
    expect(hits.map((h) => h.resourceName)).toEqual(["people/c123"]);
    expect(calls[0]!.url.pathname).toBe("/v1/people:searchContacts");
    expect(calls[0]!.url.searchParams.get("query")).toBe("");
    expect(calls[1]!.url.searchParams.get("query")).toBe("+5511988887777");
    expect(calls[1]!.url.searchParams.get("readMask")).toBe("metadata,phoneNumbers,emailAddresses");
    expect(calls[1]!.url.searchParams.get("pageSize")).toBe("30");

    expect(await client.searchContacts({ accessToken: token, query: "x@y.com" })).toEqual([]);
    expect(calls).toHaveLength(3); // no second warm-up
  });

  it("retries 429 and 503 with exponential backoff, honouring Retry-After", async () => {
    const { client, calls, sleeps } = harness([
      googleError(429, "RESOURCE_EXHAUSTED"),
      json({ error: { code: 503, status: "UNAVAILABLE" } }, 503, { "retry-after": "3" }),
      json(person()),
    ]);
    const found = await client.getContact({ accessToken: token, resourceName: "people/c123" });
    expect(found?.resourceName).toBe("people/c123");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 3000]);
  });

  it("retries a POST on 429 but never on 5xx or a network failure (no duplicate contacts)", async () => {
    const rate = harness([googleError(429, "RESOURCE_EXHAUSTED"), json(person())]);
    await rate.client.createContact({ accessToken: token, person: {} });
    expect(rate.calls).toHaveLength(2);

    const server = harness([json({ error: { code: 503, status: "UNAVAILABLE" } }, 503)]);
    await expect(
      server.client.createContact({ accessToken: token, person: {} }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(server.calls).toHaveLength(1);

    const network = harness([new TypeError("fetch failed")]);
    await expect(
      network.client.createContact({ accessToken: token, person: {} }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(network.calls).toHaveLength(1);
  });

  it("gives up after the attempt limit with a typed rate_limited error", async () => {
    const { client, calls } = harness(
      Array.from({ length: 4 }, () => googleError(429, "RESOURCE_EXHAUSTED")),
    );
    await expect(client.createContact({ accessToken: token, person: {} })).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
    expect(calls).toHaveLength(4);
  });

  it("retries a network failure and then reports unavailable", async () => {
    const { client, calls } = harness(
      Array.from({ length: 4 }, () => new TypeError("fetch failed")),
    );
    await expect(
      client.getContact({ accessToken: token, resourceName: "people/c123" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toHaveLength(4);
  });

  it.each([
    [401, "UNAUTHENTICATED", "unauthorized"],
    [403, "PERMISSION_DENIED", "forbidden"],
    [404, "NOT_FOUND", "not_found"],
    [400, "INVALID_ARGUMENT", "bad_request"],
  ])("maps %i %s to %s without retrying", async (status, name, code) => {
    const { client, calls } = harness([googleError(status, name)]);
    await expect(client.createContact({ accessToken: token, person: {} })).rejects.toMatchObject({
      code,
    });
    expect(calls).toHaveLength(1);
  });

  it("recognises a disabled People API", async () => {
    const { client } = harness([
      json(
        {
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "People API has not been used in project 1 before or it is disabled.",
            details: [
              { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" },
            ],
          },
        },
        403,
      ),
    ]);
    await expect(client.createContact({ accessToken: token, person: {} })).rejects.toMatchObject({
      code: "api_disabled",
    });
  });

  it("rejects a malformed success body instead of trusting it", async () => {
    const { client } = harness([json({ unexpected: true })]);
    await expect(client.createContact({ accessToken: token, person: {} })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
