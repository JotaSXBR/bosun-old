import { z } from "zod";

// Google People API (contacts) over plain `fetch`, per
// developers.google.com/people/api/rest/v1 (checked 2026-10-16):
//   POST  /v1/people:createContact
//   PATCH /v1/{people/*}:updateContact   (body carries metadata.sources + etag)
//   GET   /v1/people:searchContacts      (prefix match; warm-up with "" first)
//   GET   /v1/{people/*}
// Mutations for one user must be sequential — the caller (queue) guarantees it.

const BASE = "https://people.googleapis.com/v1";
const READ_FIELDS = "metadata,phoneNumbers,emailAddresses";
const SEARCH_PAGE_SIZE = "30"; // documented maximum
const MAX_ATTEMPTS = 4;
const MAX_DELAY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RESOURCE_NAME = /^people\/[A-Za-z0-9_-]+$/;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** The writable subset of a People `Person` that Bosun mirrors. */
export type GooglePersonInput = {
  names?: { unstructuredName: string }[];
  phoneNumbers?: { value: string }[];
  emailAddresses?: { value: string }[];
  organizations?: { name?: string; title?: string }[];
  addresses?: { formattedValue: string }[];
  biographies?: { value: string; contentType: "TEXT_PLAIN" }[];
  birthdays?: { date: { year?: number; month: number; day: number } }[];
  urls?: { value: string }[];
};
export type GooglePersonField = keyof GooglePersonInput;

export type GoogleContactSource = { type: string; id: string; etag: string };

/** What the sync needs back from Google, normalized. */
export type GooglePerson = {
  resourceName: string;
  source: GoogleContactSource | null;
  phones: string[];
  emails: string[];
};

export type GooglePeopleErrorCode =
  | "unauthorized"
  | "forbidden"
  | "api_disabled"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "unavailable"
  | "bad_request"
  | "invalid_response";

export class GooglePeopleError extends Error {
  readonly code: GooglePeopleErrorCode;
  readonly status: number;

  constructor(code: GooglePeopleErrorCode, status: number) {
    super(`Google People API error: ${code}`);
    this.name = "GooglePeopleError";
    this.code = code;
    this.status = status;
  }
}

export interface GooglePeopleClient {
  searchContacts(input: { accessToken: string; query: string }): Promise<GooglePerson[]>;
  getContact(input: { accessToken: string; resourceName: string }): Promise<GooglePerson | null>;
  createContact(input: { accessToken: string; person: GooglePersonInput }): Promise<GooglePerson>;
  updateContact(input: {
    accessToken: string;
    current: GooglePerson;
    person: GooglePersonInput;
    fields: GooglePersonField[];
  }): Promise<GooglePerson>;
}

export type GooglePeopleClientOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const personSchema = z.object({
  resourceName: z.string(),
  metadata: z
    .object({
      sources: z
        .array(
          z.object({
            type: z.string(),
            id: z.string().optional(),
            etag: z.string().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
  phoneNumbers: z
    .array(z.object({ value: z.string().optional(), canonicalForm: z.string().optional() }))
    .default([]),
  emailAddresses: z.array(z.object({ value: z.string().optional() })).default([]),
});

const searchSchema = z.object({
  results: z.array(z.object({ person: personSchema })).default([]),
});

const errorBodySchema = z.object({
  error: z.object({
    status: z.string().optional(),
    message: z.string().optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});
type ErrorInfo = z.infer<typeof errorBodySchema>["error"];

const isString = (value: string | undefined): value is string => Boolean(value);

function normalize(person: z.infer<typeof personSchema>): GooglePerson {
  const source = person.metadata?.sources.find((s) => s.type === "CONTACT" && s.id && s.etag);
  return {
    resourceName: person.resourceName,
    source:
      source?.id && source.etag ? { type: source.type, id: source.id, etag: source.etag } : null,
    phones: person.phoneNumbers.map((p) => p.canonicalForm ?? p.value).filter(isString),
    emails: person.emailAddresses.map((e) => e.value).filter(isString),
  };
}

function parsePerson(body: unknown): GooglePerson {
  const parsed = personSchema.safeParse(body);
  if (!parsed.success) throw new GooglePeopleError("invalid_response", 200);
  return normalize(parsed.data);
}

function isApiDisabled(info: ErrorInfo): boolean {
  const reasons = info.details?.map((d) => d.reason) ?? [];
  return (
    reasons.includes("SERVICE_DISABLED") ||
    /has not been used in project|accessNotConfigured/i.test(info.message ?? "")
  );
}

function classify(status: number, info: ErrorInfo): GooglePeopleErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return isApiDisabled(info) ? "api_disabled" : "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  const stale =
    info.status === "FAILED_PRECONDITION" || /failedPrecondition/i.test(info.message ?? "");
  return status === 400 && stale ? "conflict" : "bad_request";
}

async function toError(response: Response): Promise<GooglePeopleError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = errorBodySchema.safeParse(body);
  return new GooglePeopleError(
    classify(response.status, parsed.success ? parsed.data.error : {}),
    response.status,
  );
}

function retryDelay(attempt: number, retryAfter: string | null, random: () => number): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_DELAY_MS, seconds * 1000);
  return Math.min(MAX_DELAY_MS, 1000 * 2 ** (attempt - 1)) + Math.floor(random() * 250);
}

type Request = { method: string; url: URL; accessToken: string; body?: unknown };
type Transport = (request: Request) => Promise<unknown>;

/** `fetch` with a timeout, bounded exponential backoff on 429/5xx/network errors (429 only for POST), typed errors. */
function createTransport(options: GooglePeopleClientOptions): Transport {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;

  const attemptOnce = (request: Request) =>
    fetchImpl(request.url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${request.accessToken}`,
        "content-type": "application/json",
      },
      body: request.body === undefined ? null : JSON.stringify(request.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  return async (request) => {
    for (let attempt = 1; ; attempt += 1) {
      const response = await attemptOnce(request).catch(() => null);
      if (response?.ok) return response.json().catch(() => null);
      // A POST that errored after Google may have created the person would be
      // retried into a duplicate, so only an explicit 429 (nothing processed) retries it.
      const retryable =
        request.method === "POST"
          ? response?.status === 429
          : response === null || RETRYABLE_STATUS.has(response.status);
      if (retryable && attempt < MAX_ATTEMPTS) {
        await sleep(retryDelay(attempt, response?.headers.get("retry-after") ?? null, random));
        continue;
      }
      throw response === null ? new GooglePeopleError("unavailable", 0) : await toError(response);
    }
  };
}

function personUrl(path: string, params: Record<string, string>): URL {
  const url = new URL(`${BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function assertResourceName(resourceName: string): void {
  if (!RESOURCE_NAME.test(resourceName)) throw new GooglePeopleError("bad_request", 0);
}

export function createGooglePeopleClient(
  options: GooglePeopleClientOptions = {},
): GooglePeopleClient {
  const send = createTransport(options);
  let warmedUp = false;

  const search = async (accessToken: string, query: string) => {
    const url = personUrl("people:searchContacts", {
      query,
      readMask: READ_FIELDS,
      pageSize: SEARCH_PAGE_SIZE,
    });
    return searchSchema.safeParse(await send({ method: "GET", url, accessToken }));
  };

  return {
    async searchContacts({ accessToken, query }) {
      if (!warmedUp) {
        await search(accessToken, ""); // required warm-up so the search cache is fresh
        warmedUp = true;
      }
      const parsed = await search(accessToken, query);
      if (!parsed.success) throw new GooglePeopleError("invalid_response", 200);
      return parsed.data.results.map((r) => normalize(r.person));
    },

    async getContact({ accessToken, resourceName }) {
      assertResourceName(resourceName);
      const url = personUrl(resourceName, { personFields: READ_FIELDS });
      try {
        return parsePerson(await send({ method: "GET", url, accessToken }));
      } catch (error) {
        if (error instanceof GooglePeopleError && error.code === "not_found") return null;
        throw error;
      }
    },

    async createContact({ accessToken, person }) {
      const url = personUrl("people:createContact", { personFields: READ_FIELDS });
      return parsePerson(await send({ method: "POST", url, accessToken, body: person }));
    },

    async updateContact({ accessToken, current, person, fields }) {
      assertResourceName(current.resourceName);
      if (!current.source) throw new GooglePeopleError("bad_request", 0);
      const url = personUrl(`${current.resourceName}:updateContact`, {
        updatePersonFields: fields.join(","),
        personFields: READ_FIELDS,
      });
      const body = { ...person, metadata: { sources: [current.source] } };
      return parsePerson(await send({ method: "PATCH", url, accessToken, body }));
    },
  };
}
