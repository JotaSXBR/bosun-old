import { expect, test } from "@playwright/test";

test("composer: typing / opens the macro picker, filters by slug and inserts the macro", async ({
  page,
  context,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);

  await page.goto("/sign-up");
  await page.getByLabel("Nome").fill("E2E Macros");
  await page.getByLabel("E-mail").fill(`e2e-macros-${suffix}@crm.local`);
  await page.getByLabel("Senha", { exact: true }).fill("Password123!");
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await page.waitForURL("**/onboarding");
  await page.getByLabel("Nome da organização").fill(`E2E Macros ${suffix}`);
  await page.getByRole("button", { name: "Criar organização" }).click();
  await page.waitForURL("**/app");

  // The org owner can write macros directly (no approval step).
  await page.goto("/app/settings/service/macros");
  await page.getByLabel("Gatilho").fill("saudacao");
  await page.getByLabel("Conteúdo").fill("Olá! Em que posso ajudar?");
  await page.getByRole("button", { name: "Criar macro" }).click();
  await expect(page.getByText("/saudacao")).toBeVisible();

  // A conversation to type in: site-chat visitor writes first.
  await page.goto("/app/integrations");
  await page.getByLabel("Canal").click();
  await page.getByRole("option", { name: /Chat do site/ }).click();
  await page.getByLabel("Nome").fill("Widget Macros");
  await page.getByRole("button", { name: "Criar conexão" }).click();
  const snippet = await page.getByTestId("widget-panel").locator("code").first().textContent();
  const token = /data-token="([^"]+)"/.exec(snippet ?? "")?.[1];
  expect(token).toBeTruthy();

  const widget = await context.newPage();
  await widget.goto(`/widget-demo?token=${token}`);
  await widget.locator(".bw-bubble").click();
  await widget.locator(".bw-form input[name=name]").fill("Macro Visitor");
  await widget.locator(".bw-form input[name=email]").fill(`visitor-${suffix}@example.com`);
  await widget.locator(".bw-form input[name=phone]").fill("11987654321");
  await widget.locator(".bw-form button[type=submit]").click();
  await widget.locator(".bw-compose input[name=text]").fill("Oi, preciso de ajuda");
  await widget.locator(".bw-compose button[type=submit]").click();
  await expect(widget.locator(".bw-msgs")).toContainText("Oi, preciso de ajuda", {
    timeout: 40_000,
  });

  await page.goto("/app/inbox");
  await page.getByRole("link", { name: /Macro Visitor/ }).click();
  const box = page.getByPlaceholder("Responder ao cliente…");
  const picker = page.getByTestId("macro-picker");

  // No slug matches → the empty message, and nothing is inserted.
  await box.fill("/zzz");
  await expect(picker).toContainText('Nenhuma macro para "/zzz".');

  // Typing a prefix lists the macro; Enter inserts its content in place of the trigger.
  await box.fill("/sau");
  await expect(picker).toContainText("/saudacao");
  await box.press("Enter");
  await expect(picker).toBeHidden();
  await expect(box).toHaveValue("Olá! Em que posso ajudar?");

  // The trigger is recognised after earlier text, and a click picks it too.
  await box.fill("Bom dia, /sau");
  await picker.getByRole("button", { name: /\/saudacao/ }).click();
  await expect(box).toHaveValue("Bom dia, Olá! Em que posso ajudar?");
});
