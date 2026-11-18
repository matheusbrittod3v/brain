import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { deviceAuthorization } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { EmailService } from "./email.js";
import { hashPassword, verifyPassword } from "./password.js";

/**
 * Configures Better Auth with Drizzle PostgreSQL adapter (when provided),
 * Argon2id password hashing, env-controlled registration,
 * SMTP email verification via Nodemailer, and OAuth2 Device Authorization Flow for MCP/CLI.
 */
export function createBrainBetterAuth(options?: {
  secret?: string;
  baseURL?: string;
  emailService?: EmailService;
  db?: unknown;
  schema?: Record<string, unknown>;
}): ReturnType<typeof betterAuth> {
  const emailService = options?.emailService ?? new EmailService();
  const registrationDisabled =
    process.env.BRAIN_REGISTRATION_ENABLED?.trim().toLowerCase() === "false" ||
    process.env.BRAIN_REGISTRATION_ENABLED?.trim() === "0";
  const requireEmailVerification =
    process.env.BRAIN_REQUIRE_EMAIL_VERIFICATION?.trim().toLowerCase() === "true" ||
    process.env.BRAIN_REQUIRE_EMAIL_VERIFICATION?.trim() === "1";

  return betterAuth({
    ...(options?.db
      ? {
          database: drizzleAdapter(options.db as never, {
            provider: "pg",
            ...(options.schema ? { schema: options.schema } : {})
          })
        }
      : {}),
    secret: options?.secret || process.env.BRAIN_JWT_SECRET,
    baseURL: options?.baseURL || process.env.BRAIN_BASE_URL || "http://localhost:3333",
    emailAndPassword: {
      enabled: true,
      disableSignUp: registrationDisabled,
      requireEmailVerification,
      password: {
        hash: (password) => hashPassword(password),
        verify: ({ hash, password }) => verifyPassword(hash, password)
      }
    },
    emailVerification: {
      sendOnSignUp: requireEmailVerification,
      sendVerificationEmail: async ({ user, token }) => {
        await emailService.sendVerificationEmail({
          to: user.email,
          name: user.name || user.email,
          verificationToken: token
        });
      }
    },
    plugins: [
      passkey({
        rpID: process.env.BRAIN_RP_ID || "localhost",
        rpName: "Brain OS"
      }),
      deviceAuthorization({
        verificationUri: "/auth/oauth"
      })
    ]
  }) as unknown as ReturnType<typeof betterAuth>;
}

