"use client";

import { IconButton } from "@crm/design-system/components/icon-button";
import { Input } from "@crm/design-system/components/input";
import { useTranslations } from "next-intl";
import type { ComponentProps } from "react";
import { useState } from "react";

type Props = Omit<ComponentProps<typeof Input>, "type" | "icon" | "trailing" | "shape" | "size">;

/** Password field of the auth forms, with the show/hide toggle. */
export function PasswordInput(props: Props) {
  const tAuth = useTranslations("auth");
  const [show, setShow] = useState(false);
  return (
    <Input
      shape="rounded"
      size="lg"
      type={show ? "text" : "password"}
      icon="lock"
      trailing={
        <IconButton
          size="sm"
          variant="ghost"
          icon={show ? "eye-off" : "eye"}
          label={tAuth(show ? "hidePassword" : "showPassword")}
          onClick={() => setShow((v) => !v)}
          className="-mr-2"
        />
      }
      {...props}
    />
  );
}
