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
function useSignIn(t: ReturnType<typeof useTranslations>) {
  const tVal = useTranslations("validation");
  const router = useRouter();
  const searchParams = useSearchParams();
  // Invitation links land on /accept-invitation — honor `next` so sign-in
  // returns the invitee to the pending invite. Internal paths only.
  const next = safeNext(searchParams.get("next"));
  const formSchema = z.object({
    email: z.email(tVal("invalidEmail")),
    password: z.string().min(8, tVal("passwordMin")),
  });
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    const { error } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });
    if (error) {
      toast.error(error.message ?? t("error"));
      return;
    }
    router.push(next ?? "/app");
    router.refresh();
  }

  return { form, next, onSubmit };
}

export default function SignInPage() {
  const t = useTranslations("auth.signIn");
  const tl = useTranslations("auth.layout");
  const tc = useTranslations("common");
  const tAuth = useTranslations("auth");
  const [showPassword, setShowPassword] = useState(false);
  const { form, next, onSubmit } = useSignIn(t);

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
                    autoComplete="current-password"
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
            {t("noAccount")}{" "}
            <Link
              href={next ? `/sign-up?next=${encodeURIComponent(next)}` : "/sign-up"}
              className="underline"
            >
              {t("signUpLink")}
            </Link>
          </p>
        </form>
      </Form>
    </AuthLayout>
  );
}
