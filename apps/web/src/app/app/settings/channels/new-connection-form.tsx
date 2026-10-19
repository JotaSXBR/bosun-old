"use client";

import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@crm/design-system/components/form";
import { Input } from "@crm/design-system/components/input";
import { Select } from "@crm/design-system/components/select";
import { toast } from "@crm/design-system/components/toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import type { CreateConnectionResult } from "@/server/actions/integrations";
import { createChannelConnectionAction } from "@/server/actions/integrations";

import { PairingPanel } from "./pairing-panel";

type QrCode = { mimeType: string; data: string };

type T = ReturnType<typeof useTranslations>;

// WAHA creds are platform-owned (env) — creating one needs only a name and
// the QR opens right away. Meta credentials stay per-connection.
const formSchema = (t: T) => {
  const nameField = z.string().trim().min(1, t("form.nameRequired")).max(120);
  const required = () => z.string().min(1, t("form.required"));
  return z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("waha"),
      name: nameField,
    }),
    z.object({
      kind: z.literal("meta_cloud"),
      name: nameField,
      phoneNumberId: required(),
      accessToken: required(),
      appSecret: required(),
      verifyToken: required(),
      graphApiVersion: z.string().optional(),
    }),
    z.object({
      kind: z.literal("site_chat"),
      name: nameField,
    }),
  ]);
};

type FormValues = z.input<ReturnType<typeof formSchema>>;

const META_FIELDS = [
  { name: "phoneNumberId", label: "Phone number ID", placeholder: "" },
  { name: "accessToken", label: "Access token", placeholder: "" },
  { name: "appSecret", label: "App secret", placeholder: "" },
  { name: "verifyToken", label: "Verify token", placeholder: "" },
  { name: "graphApiVersion", label: "", placeholder: "v26.0" },
] as const;

const emptyValues = (kind: FormValues["kind"]): FormValues =>
  kind === "meta_cloud"
    ? {
        kind,
        name: "",
        phoneNumberId: "",
        accessToken: "",
        appSecret: "",
        verifyToken: "",
        graphApiVersion: "",
      }
    : { kind, name: "" };

type Created = Extract<CreateConnectionResult, { ok: true }>;

type ConnForm = UseFormReturn<FormValues>;

function KindNameRow({ form }: { form: ConnForm }) {
  const t = useTranslations("integrations");
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField
        control={form.control}
        name="kind"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("form.channel")}</FormLabel>
            <FormControl>
              <Select
                options={[
                  { value: "waha", label: t("form.kindWaha") },
                  { value: "meta_cloud", label: t("form.kindMeta") },
                  { value: "site_chat", label: t("form.kindSiteChat") },
                ]}
                value={field.value}
                onChange={field.onChange}
                name={field.name}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("form.name")}</FormLabel>
            <FormControl>
              <Input shape="rounded" placeholder={t("form.namePlaceholder")} {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

function MetaFields({ form }: { form: ConnForm }) {
  const t = useTranslations("integrations");
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {META_FIELDS.map((item) => (
        <FormField
          key={`meta_cloud-${item.name}`}
          control={form.control}
          name={item.name}
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {item.name === "graphApiVersion" ? t("form.graphApiVersion") : item.label}
              </FormLabel>
              <FormControl>
                <Input shape="rounded" placeholder={item.placeholder} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      ))}
    </div>
  );
}

function useCreateConnection(form: ConnForm) {
  const t = useTranslations("integrations");
  const [pairing, setPairing] = useState<{ id: string; qr?: QrCode } | null>(null);

  function announce(kind: FormValues["kind"], result: Created) {
    if (result.warning) toast.warning(result.warning);
    if (kind === "site_chat") {
      toast.success(t("form.widgetCreated"));
    } else if (kind === "waha") {
      if (result.status === "connected") {
        toast.success(t("actions.connected"));
      } else {
        setPairing({ id: result.connectionId, qr: result.qrCode });
      }
    } else {
      toast.success(
        result.status === "connected" ? t("form.connectedValidated") : t("form.created"),
      );
    }
  }

  async function onSubmit(values: FormValues) {
    const { kind, name, ...credentials } = values;
    const result = await createChannelConnectionAction(
      kind === "meta_cloud" ? { kind, name, credentials } : { kind, name },
    );
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    form.reset(emptyValues(kind));
    announce(kind, result);
  }

  return { pairing, setPairing, onSubmit };
}

export function NewConnectionForm() {
  const t = useTranslations("integrations");
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema(t)),
    defaultValues: { kind: "waha", name: "" },
  });
  const kind = useWatch({ control: form.control, name: "kind" });
  const { pairing, setPairing, onSubmit } = useCreateConnection(form);

  return (
    <Card title={t("form.title")} subtitle={t("form.description")}>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <KindNameRow form={form} />
          {kind === "meta_cloud" && <MetaFields form={form} />}
          <Button variant="primary" type="submit" disabled={form.formState.isSubmitting}>
            {t("form.submit")}
          </Button>
        </form>
      </Form>
      {pairing && (
        <PairingPanel id={pairing.id} initialQr={pairing.qr} onDone={() => setPairing(null)} />
      )}
    </Card>
  );
}
