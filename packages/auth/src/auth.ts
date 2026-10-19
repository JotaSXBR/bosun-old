import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { ServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { schema } from "@crm/db";
import { createLogger } from "@crm/observability";
import { ac, roles } from "@crm/permissions";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { admin, organization } from "better-auth/plugins";
import { adminAc, defaultRoles } from "better-auth/plugins/admin/access";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export type AuthOptions = {
  db: Database;
  env: ServerEnv;
  /**
   * Outbound email hook (verification, password reset). Until @crm/email
   * exists the default just logs — real wiring lands with that package.
   */
  sendEmail?: ((message: EmailMessage) => Promise<void>) | undefined;
};

const defaultSendEmailLogger = createLogger({ bindings: { component: "auth:email" } });

const defaultSendEmail = (message: EmailMessage): Promise<void> => {
  // Never log `text`: auth emails carry token-bearing URLs (reset/verify).
  defaultSendEmailLogger.info("sending auth email (default hook)", {
    to: message.to,
    subject: message.subject,
  });
  return Promise.resolve();
};

type SendEmail = (message: EmailMessage) => Promise<void>;

const authSchema = {
  users: schema.users,
  sessions: schema.sessions,
  accounts: schema.accounts,
  verifications: schema.verifications,
  organizations: schema.organizations,
  organization_members: schema.organizationMembers,
  organization_invitations: schema.organizationInvitations,
};

function emailFlows(env: ServerEnv, sendEmail: SendEmail) {
  return {
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: env.auth.requireEmailVerification,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        await sendEmail({
          to: user.email,
          subject: "Redefinição de senha",
          text: `Use este link para redefinir sua senha: ${url}`,
        });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        await sendEmail({
          to: user.email,
          subject: "Verifique seu e-mail",
          text: `Use este link para verificar seu e-mail: ${url}`,
        });
      },
    },
  };
}

type Invitation = {
  id: string;
  email: string;
  organization: { name: string };
  inviter: { user: { name: string } };
};

function organizationPlugin(env: ServerEnv, sendEmail: SendEmail) {
  return organization({
    ac,
    roles,
    allowUserToCreateOrganization: true,
    creatorRole: "owner",
    schema: {
      organization: { modelName: "organizations" },
      member: { modelName: "organization_members" },
      invitation: { modelName: "organization_invitations" },
    },
    // Invitation e-mail — the copyable link is the fallback, so a
    // provider failure logs but never breaks the invite.
    sendInvitationEmail: async ({ id, email, organization, inviter }: Invitation) => {
      const url = `${env.appUrl}/accept-invitation/${id}`;
      try {
        await sendEmail({
          to: email,
          subject: `${organization.name} — convite para participar`,
          text: `${inviter.user.name} convidou você para participar de ${organization.name}. Aceite o convite: ${url}`,
        });
      } catch (error) {
        defaultSendEmailLogger.warn("invitation email failed", {
          invitationId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}

export function createAuth({ db, env, sendEmail = defaultSendEmail }: AuthOptions) {
  return betterAuth({
    appName: "CRM",
    secret: env.auth.secret,
    baseURL: env.appUrl,
    trustedOrigins: [env.appUrl],
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    user: { modelName: "users" },
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    advanced: {
      database: { generateId: "uuid" },
    },
    ...emailFlows(env, sendEmail),
    rateLimit: { enabled: env.auth.rateLimit },
    plugins: [
      organizationPlugin(env, sendEmail),
      // platform_admin gets the full built-in admin permission set.
      admin({
        adminRoles: ["platform_admin"],
        roles: { ...defaultRoles, platform_admin: adminAc },
      }),
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
