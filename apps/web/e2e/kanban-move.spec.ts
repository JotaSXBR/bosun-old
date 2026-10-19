import { expect, type Page, test } from "@playwright/test";

/** Sign up, create an org, a contact, the template funnel and one deal in its first stage. */
async function boardWithOneDeal(page: Page, title: string) {
  const suffix = crypto.randomUUID().slice(0, 8);

  await page.goto("/sign-up");
  await page.getByLabel("Nome").fill("E2E Kanban");
  await page.getByLabel("E-mail").fill(`e2e-kanban-${suffix}@crm.local`);
  await page.getByLabel("Senha", { exact: true }).fill("Password123!");
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await page.waitForURL("**/onboarding");
  await page.getByLabel("Nome da organização").fill(`E2E Kanban ${suffix}`);
  await page.getByRole("button", { name: "Criar organização" }).click();
  await page.waitForURL("**/app");

  await page.goto("/app/contacts");
  await page.getByRole("button", { name: "Novo contato" }).click();
  const contact = page.getByRole("dialog");
  await contact.getByLabel("Nome").fill("Cliente Kanban");
  await contact.getByLabel("Telefone (WhatsApp)").fill("+55 11 97777-6666");
  await contact.getByRole("button", { name: "Criar contato" }).click();
  await expect(page.getByTestId("contact-list")).toContainText("Cliente Kanban");

  await page.goto("/app/settings/sales/funnels");
  await page.getByRole("button", { name: "Criar funil" }).click();
  const funnel = page.getByRole("dialog");
  await funnel.getByLabel("Nome").fill("Funil Kanban");
  await funnel.getByLabel("Modelo").click();
  await page.getByRole("option", { name: /Imobiliária/ }).click();
  await funnel.getByRole("button", { name: "Criar funil" }).click();
  await page.waitForURL(/funnel=/);

  await page.goto("/app/deals");
  const board = page.getByTestId("kanban-board");
  await expect(board).toBeVisible();
  await addDeal(page, title);
  return board;
}

/** Adds a deal to the board's first stage through its "Deal" button. */
async function addDeal(page: Page, title: string) {
  const board = page.getByTestId("kanban-board");
  await board.getByRole("button", { name: "Deal", exact: true }).first().click();
  const deal = page.getByRole("dialog");
  await deal.getByLabel("Título").fill(title);
  await deal.getByLabel("Contato", { exact: true }).click();
  await page.getByRole("option", { name: /Cliente Kanban/ }).click();
  await deal.getByRole("button", { name: "Criar deal" }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
  await expect(board.getByRole("button", { name: `Deal ${title}`, exact: true })).toBeVisible();
}

const columns = (board: ReturnType<Page["getByTestId"]>) =>
  board.locator('[data-testid^="stage-column-"]');

test("kanban: a deal moves to another stage through the card menu and stays there", async ({
  page,
}) => {
  const board = await boardWithOneDeal(page, "Deal do menu");
  const [first, second] = [columns(board).nth(0), columns(board).nth(1)];
  await expect(first).toContainText("Deal do menu");

  await board.getByRole("button", { name: /Ações do deal Deal do menu/ }).click();
  await page.getByRole("menuitem", { name: "Mover para" }).click();
  await page.getByRole("menuitem", { name: "Qualificação" }).click();

  await expect(second).toContainText("Deal do menu");
  await expect(first).not.toContainText("Deal do menu");
  await page.reload();
  await expect(columns(board).nth(1)).toContainText("Deal do menu");
  await expect(columns(board).nth(0)).not.toContainText("Deal do menu");
});

test("kanban: dragging a deal card moves it to another stage and persists after reload", async ({
  page,
}) => {
  const board = await boardWithOneDeal(page, "Deal arrastado");
  await addDeal(page, "Deal vizinho");
  const handle = board.getByRole("button", { name: "Deal Deal arrastado", exact: true });
  const neighbour = board.getByTestId(/deal-card-/).filter({ hasText: "Deal vizinho" });
  await expect(columns(board).nth(0)).toContainText("Deal arrastado");

  const from = await handle.boundingBox();
  const over = await neighbour.boundingBox();
  const to = await columns(board).nth(2).boundingBox();
  if (!from || !over || !to) throw new Error("board is not laid out");
  const centre = (box: { x: number; y: number; width: number; height: number }) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  const drag = async (target: { x: number; y: number }, steps: number) => {
    const here = centre(from);
    for (let step = 1; step <= steps; step++) {
      await page.mouse.move(
        here.x + ((target.x - here.x) * step) / steps,
        here.y + ((target.y - here.y) * step) / steps,
      );
    }
  };

  await page.mouse.move(centre(from).x, centre(from).y);
  await page.mouse.down();
  // dnd-kit's pointer sensor only activates after a few px of movement; hovering
  // the neighbour makes the sortable shift it through the --drag-transform variable.
  await drag(centre(over), 20);
  await expect
    .poll(() => neighbour.evaluate((el) => getComputedStyle(el).transform))
    .not.toBe("none");
  await drag({ x: to.x + to.width / 2, y: to.y + 80 }, 20);
  await page.mouse.up();

  await expect(columns(board).nth(2)).toContainText("Deal arrastado");
  await expect(columns(board).nth(0)).not.toContainText("Deal arrastado");
  await page.reload();
  await expect(columns(board).nth(2)).toContainText("Deal arrastado");
  await expect(columns(board).nth(0)).not.toContainText("Deal arrastado");
  await expect(columns(board).nth(0)).toContainText("Deal vizinho");
});
