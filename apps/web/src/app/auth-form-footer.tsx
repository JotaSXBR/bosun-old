"use client";

import { Button } from "@crm/design-system/components/button";
import Link from "next/link";
import type { ReactNode } from "react";

/** Submit button plus the "other auth page" link shared by sign-in and sign-up. */
export function AuthFormFooter({
  submitting,
  submitLabel,
  prompt,
  href,
  linkLabel,
}: {
  submitting: boolean;
  submitLabel: ReactNode;
  prompt: ReactNode;
  href: string;
  linkLabel: ReactNode;
}) {
  return (
    <>
      <Button variant="primary" type="submit" size="lg" fullWidth loading={submitting}>
        {submitLabel}
      </Button>
      <p className="text-ink-muted text-center text-sm">
        {prompt}{" "}
        <Link href={href} className="underline">
          {linkLabel}
        </Link>
      </p>
    </>
  );
}
