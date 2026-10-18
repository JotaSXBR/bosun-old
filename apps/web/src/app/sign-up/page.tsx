"use client";

import { Button } from "@crm/design-system/components/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@crm/design-system/components/form";
import { IconButton } from "@crm/design-system/components/icon-button";
import { Input } from "@crm/design-system/components/input";
import { toast } from "@crm/design-system/components/toast";
import { AuthLayout } from "@crm/design-system/templates/auth-layout";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { authClient } from "@/lib/auth-client";

/** `next` must be an internal path — rejects absolute/protocol-relative URLs. */
function safeNext(value: string | null): string | null {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : null;
}

/** Form state, schema and submit handler of the page. */
function useSignUp(t: ReturnType<typeof useTranslations>) {
  const tVal = useTranslations("validation");
  const router = useRouter();
  const searchParams = useSearchParams();
  // Invitation links: invitees create the account then return to the invite.
  const next = safeNext(searchParams.get("next"));
  const invitedEmail = searchParams.get("email") ?? "";
  const formSchema = z.object({
    name: z.string().min(2, tVal("nameMin")),
    email: z.email(tVal("invalidEmail")),
    password: z.string().min(8, tVal("passwordMin")),
  });
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", email: invitedEmail, password: "" },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    const { error } = await authClient.signUp.email({
      name: values.name,
      email: values.email,
      password: values.password,
    });
    if (error) {
      toast.error(error.message ?? t("error"));
      return;
    }
    // With a pending invite the org already exists — skip the wizard.
    router.push(next ?? "/onboarding");
    router.refresh();
  }

  return { form, next, onSubmit };
}

export default function SignUpPage() {
  const t = useTranslations("auth.signUp");
  const tl = useTranslations("auth.layout");
  const tc = useTranslations("common");
  const tAuth = useTranslations("auth");
  const [showPassword, setShowPassword] = useState(false);
  const { form, next, onSubmit } = useSignUp(t);

  return (
    <AuthLayout
      lead={tl("lead")}
      payoff={tl("payoff")}
      nodes={tl.raw("nodes") as [string, string, string, string]}
    >
      <div className="mb-4">
        <h1 className="font-display text-h2 text-ink-strong font-semibold">{t("title")}</h1>
        <p className="text-ink-muted text-md mt-2">{t("description")}</p>
      </div>
      <Form {...form}>
        <form method="post" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{tc("name")}</FormLabel>
                <FormControl>
                  <Input shape="rounded" size="lg" icon="user" autoComplete="name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{tc("email")}</FormLabel>
                <FormControl>
                  <Input
                    shape="rounded"
                    size="lg"
                    type="email"
                    icon="at-sign"
                    autoComplete="email"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{tc("password")}</FormLabel>
                <FormControl>
                  <Input
                    shape="rounded"
                    size="lg"
                    type={showPassword ? "text" : "password"}
                    icon="lock"
                    autoComplete="new-password"
                    trailing={
                      <IconButton
                        size="sm"
                        variant="ghost"
                        icon={showPassword ? "eye-off" : "eye"}
                        label={tAuth(showPassword ? "hidePassword" : "showPassword")}
                        onClick={() => setShowPassword((v) => !v)}
                        className="-mr-2"
                      />
                    }
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button
            variant="primary"
            type="submit"
            size="lg"
            fullWidth
            loading={form.formState.isSubmitting}
          >
            {t("submit")}
          </Button>
          <p className="text-ink-muted text-center text-sm">
            {t("hasAccount")}{" "}
            <Link
              href={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"}
              className="underline"
            >
              {t("signInLink")}
            </Link>
          </p>
        </form>
      </Form>
    </AuthLayout>
  );
}
