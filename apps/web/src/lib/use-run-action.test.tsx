// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRunAction } from "./use-run-action";

const refresh = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@crm/design-system/components/toast", () => ({ toast }));

async function runAction(
  result: { ok: true } | { ok: false; error: string },
  success?: string,
  onSuccess?: () => void,
) {
  const { result: hook } = renderHook(() => useRunAction());
  await act(() => {
    hook.current.run(Promise.resolve(result), success, onSuccess);
    return Promise.resolve();
  });
  return hook;
}

describe("useRunAction", () => {
  beforeEach(() => {
    refresh.mockClear();
    toast.error.mockClear();
    toast.success.mockClear();
  });

  it("toasts the error and neither calls onSuccess nor refreshes on a failure", async () => {
    const onSuccess = vi.fn();
    await runAction({ ok: false, error: "nope" }, "feito", onSuccess);
    expect(toast.error).toHaveBeenCalledWith("nope");
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("toasts the success message, then calls onSuccess and refreshes", async () => {
    const order: string[] = [];
    toast.success.mockImplementation(() => order.push("toast"));
    refresh.mockImplementation(() => order.push("refresh"));
    await runAction({ ok: true }, "feito", () => order.push("onSuccess"));
    expect(toast.success).toHaveBeenCalledWith("feito");
    expect(toast.error).not.toHaveBeenCalled();
    expect(order).toEqual(["toast", "onSuccess", "refresh"]);
  });

  it("refreshes without a toast when no success message is given", async () => {
    await runAction({ ok: true });
    expect(toast.success).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("is pending until the action settles", async () => {
    const { result } = renderHook(() => useRunAction());
    let settle: (value: { ok: true }) => void = () => undefined;
    await act(() => {
      result.current.run(new Promise((resolve) => (settle = resolve)));
      return Promise.resolve();
    });
    expect(result.current.pending).toBe(true);
    await act(() => {
      settle({ ok: true });
      return Promise.resolve();
    });
    expect(result.current.pending).toBe(false);
  });
});
