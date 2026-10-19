import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// Regression: the right-click panel used to hand its whole props object
// (close(), panelRef, currentText, can* …) to the message Server Actions. The
// typecheck cannot see it and the actions still ran, but UI state leaked into
// the action payload. Each action must send only the ids (plus emoji/text).
const ALLOWED_KEYS = new Set(["conversationId", "messageId", "emoji", "text"]);

async function setupConversationWithAgentReply(page: Page, context: BrowserContext) {
  const suffix = crypto.randomUUID().slice(0, 8);

  await page.goto("/sign-up");
  await page.getByLabel("Nome").fill("E2E Ctx");
  await page.getByLabel("E-mail").fill(`e2e-ctx-${suffix}@crm.local`);
  await page.getByLabel("Senha", { exact: true }).fill("Password123!");
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await page.waitForURL("**/onboarding");
  await page.getByLabel("Nome da organização").fill(`E2E Ctx ${suffix}`);
  await page.getByRole("button", { name: "Criar organização" }).click();
  await page.waitForURL("**/app");

  await page.goto("/app/integrations");
  await page.getByLabel("Canal").click();
  await page.getByRole("option", { name: /Chat do site/ }).click();
  await page.getByLabel("Nome").fill("Widget Ctx");
  await page.getByRole("button", { name: "Criar conexão" }).click();
  const snippet = await page.getByTestId("widget-panel").locator("code").first().textContent();
  const token = /data-token="([^"]+)"/.exec(snippet ?? "")?.[1];
  expect(token).toBeTruthy();

  const widget = await context.newPage();
  await widget.goto(`/widget-demo?token=${token}`);
  await widget.locator(".bw-bubble").click();
  await widget.locator(".bw-form input[name=name]").fill("Ctx Visitor");
  await widget.locator(".bw-form input[name=email]").fill(`visitor-${suffix}@example.com`);
  await widget.locator(".bw-form input[name=phone]").fill("11987654321");
  await widget.locator(".bw-form button[type=submit]").click();
  await widget.locator(".bw-compose input[name=text]").fill("Preciso de ajuda");
  await widget.locator(".bw-compose button[type=submit]").click();
  await expect(widget.locator(".bw-msgs")).toContainText("Preciso de ajuda", { timeout: 40_000 });

  await page.goto("/app/inbox");
  await page.getByRole("link", { name: /Ctx Visitor/ }).click();
  await page.getByPlaceholder("Responder ao cliente…").fill("Resposta do agente");
  await page.getByRole("button", { name: "Enviar", exact: true }).click();
  const thread = page.getByTestId("message-thread");
  await expect(thread).toContainText("Resposta do agente");
  return thread.getByText("Resposta do agente");
}

test("right-click message menu: opens, dismisses and its actions reach the server", async ({
  page,
  context,
}) => {
  const actionBodies: string[] = [];
  page.on("request", (request) => {
    const body = request.postData() ?? "";
    if (request.method() === "POST" && body.includes('"messageId"')) actionBodies.push(body);
  });
  const sentActions = async (count: number) =>
    expect.poll(() => actionBodies.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(count);

  const bubble = await setupConversationWithAgentReply(page, context);
  const panel = page.getByTestId("message-context-menu");

  // Opens on right-click, closes on Escape.
  await bubble.click({ button: "right" });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  // React: the Server Action must leave the browser (the provider may refuse it).
  await bubble.click({ button: "right" });
  await panel.getByRole("button", { name: "👍" }).click();
  await sentActions(1);
  await expect(panel).toBeHidden();

  // Edit: the editor opens and saving posts the action.
  await bubble.click({ button: "right" });
  await panel.getByRole("button", { name: "Editar" }).click();
  await panel.getByRole("textbox").fill("Resposta editada");
  await panel.getByRole("button", { name: "Salvar" }).click();
  await sentActions(2);

  // Delete: confirm step, then the action posts.
  await page.keyboard.press("Escape");
  await bubble.click({ button: "right" });
  await panel.getByRole("button", { name: "Apagar" }).click();
  await panel.getByRole("button", { name: "Sim" }).click();
  await sentActions(3);

  expect(actionBodies).toHaveLength(3);
  for (const body of actionBodies) {
    const [payload] = JSON.parse(body) as Record<string, unknown>[];
    expect(Object.keys(payload ?? {}).filter((key) => !ALLOWED_KEYS.has(key))).toEqual([]);
  }
});
