"use client";

import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@crm/design-system/components/form";
import { Input } from "@crm/design-system/components/input";
import { toast } from "@crm/design-system/components/toast";
import { AuthLayout } from "@crm/design-system/templates/auth-layout";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { authClient } from "@/lib/auth-client";

import { AuthFormFooter } from "../auth-form-footer";
import { PasswordInput } from "../password-input";

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

type AuthForm = ReturnType<typeof useSignIn>["form"];

function EmailField({ form }: { form: AuthForm }) {
  const tc = useTranslations("common");
  return (
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
  );
}

function SignInForm() {
  const t = useTranslations("auth.signIn");
  const tc = useTranslations("common");
  const { form, next, onSubmit } = useSignIn(t);

  return (
    <Form {...form}>
      <form method="post" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <EmailField form={form} />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tc("password")}</FormLabel>
              <FormControl>
                <PasswordInput autoComplete="current-password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <AuthFormFooter
          submitting={form.formState.isSubmitting}
          submitLabel={t("submit")}
          prompt={t("noAccount")}
          href={next ? `/sign-up?next=${encodeURIComponent(next)}` : "/sign-up"}
          linkLabel={t("signUpLink")}
        />
      </form>
    </Form>
  );
}

export default function SignInPage() {
  const t = useTranslations("auth.signIn");
  const tl = useTranslations("auth.layout");

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
      <SignInForm />
    </AuthLayout>
  );
}
