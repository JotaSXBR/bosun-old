// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useOnOpen } from "./use-on-open";

function setup(initialOpen: boolean) {
  const onOpen = vi.fn();
  const hook = renderHook(({ open }) => useOnOpen(open, onOpen), {
    initialProps: { open: initialOpen },
  });
  return { onOpen, ...hook };
}

describe("useOnOpen", () => {
  it("does not fire on mount, whether closed or already open", () => {
    expect(setup(false).onOpen).not.toHaveBeenCalled();
    expect(setup(true).onOpen).not.toHaveBeenCalled();
  });

  it("fires once on each closed → open transition", () => {
    const { onOpen, rerender } = setup(false);
    rerender({ open: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
    rerender({ open: false });
    rerender({ open: true });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("does not fire on re-renders that keep the same state, or on closing", () => {
    const { onOpen, rerender } = setup(false);
    rerender({ open: true });
    rerender({ open: true });
    rerender({ open: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
    rerender({ open: false });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
