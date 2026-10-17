import { expect, test } from "@playwright/test";

test("Google Contacts card: save client, start consent, reject a forged callback", async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);

  await page.goto("/sign-up");
  await page.getByLabel("Nome").fill("E2E Google");
  await page.getByLabel("E-mail").fill(`e2e-google-${suffix}@crm.local`);
  await page.getByLabel("Senha", { exact: true }).fill("Password123!");
  await page.getByRole("button", { name: "Cadastrar" }).click();

  await page.waitForURL("**/onboarding");
  await page.getByLabel("Nome da organização").fill(`E2E Google ${suffix}`);
  await page.getByRole("button", { name: "Criar organização" }).click();
  await page.waitForURL("**/app");

  // Never reach the real Google: stub the consent page.
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>google stub</p>" }),
  );

  await page.goto("/app/settings/channels");
  const card = page.getByTestId("google-card");
  await expect(card).toBeVisible();
  await expect(page.getByText("Google Contatos", { exact: true })).toBeVisible();
  await expect(card.locator("code")).toContainText("/api/integrations/google/callback");

  await card.getByLabel("Client ID").fill("e2e-client-id.apps.googleusercontent.com");
  await card.getByLabel("Client secret").fill("e2e-client-secret");
  await card.getByRole("button", { name: "Conectar com o Google" }).click();

  await page.waitForURL(/accounts\.google\.com/);
  const consent = new URL(page.url());
  expect(consent.searchParams.get("client_id")).toBe("e2e-client-id.apps.googleusercontent.com");
  expect(consent.searchParams.get("access_type")).toBe("offline");
  expect(consent.searchParams.get("scope")).toContain("auth/contacts");
  expect(consent.searchParams.get("state")).toBeTruthy();

  // A callback with a state we never issued must not connect anything.
  await page.goto("/api/integrations/google/callback?code=forged&state=forged");
  await page.waitForURL("**/app/settings/channels?google=state");
  // .first(): in dev the load-time toast has rendered twice (cause not confirmed).
  await expect(page.getByText("Autorização expirada. Conecte de novo.").first()).toBeVisible();
  await expect(page.getByTestId("google-status")).toHaveText("aguardando autorização");
  // Nothing is sent before a connected account exists.
  await expect(card.getByRole("button", { name: "Sincronizar agora" })).toHaveCount(0);
});
