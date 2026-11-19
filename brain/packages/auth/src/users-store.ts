import { randomBytes, randomUUID } from "node:crypto";
import { BrainError } from "@brain/core";
import { hashPassword, verifyPassword } from "./password.js";
import type { SystemPermission } from "./index.js";

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  passwordHash: string;
  emailVerified: boolean;
  roles: string[];
  allowedProjects: string[];
  allowedPolicies: string[];
  customPermissions?: SystemPermission[];
  linkedAgentIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VerificationTokenEntry {
  userId: string;
  token: string;
  type: "email_verification" | "password_reset";
  expiresAt: number;
}

export class UsersStore {
  private users = new Map<string, AuthUser>(); // userId -> AuthUser
  private emailIndex = new Map<string, string>(); // email (lowercase) -> userId
  private verificationTokens = new Map<string, VerificationTokenEntry>(); // token -> entry

  constructor() {
    // Seed default admin in memory
    void this.seedDefaultAdmin();
  }

  private async seedDefaultAdmin(): Promise<void> {
    const configuredEmail = process.env.BRAIN_ADMIN_EMAIL?.trim();
    const adminPass = process.env.BRAIN_ADMIN_PASSWORD;
    if (!configuredEmail || !adminPass || adminPass.length < 12 || adminPass === "admin123456") return;
    const adminEmail = configuredEmail.toLowerCase();
    if (!this.emailIndex.has(adminEmail)) {
      const hash = await hashPassword(adminPass);
      const user: AuthUser = {
        id: "usr_admin_default",
        tenantId: "default-org",
        email: adminEmail,
        name: "Administrador Brain",
        passwordHash: hash,
        emailVerified: true,
        roles: ["admin", "developer", "tech-lead"],
        allowedProjects: ["local-project", "brain", "staf-web"],
        allowedPolicies: ["public-org", "internal-project", "confidential-business", "restricted-security"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      this.users.set(user.id, user);
      this.emailIndex.set(adminEmail, user.id);
    }
  }

  isRegistrationEnabled(): boolean {
    const envVal = process.env.BRAIN_REGISTRATION_ENABLED?.trim().toLowerCase();
    if (envVal === "false" || envVal === "0" || envVal === "no") return false;
    return true; // default enabled
  }

  isEmailVerificationRequired(): boolean {
    const envVal = process.env.BRAIN_REQUIRE_EMAIL_VERIFICATION?.trim().toLowerCase();
    return envVal === "true" || envVal === "1" || envVal === "yes";
  }

  async registerUser(params: {
    email: string;
    password: string;
    name: string;
    tenantId?: string;
    roles?: string[];
    allowedProjects?: string[];
    allowedPolicies?: string[];
  }): Promise<{ user: AuthUser; verificationToken?: string }> {
    if (!this.isRegistrationEnabled()) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "O cadastro de novos usuários está desabilitado pelo administrador.", 403);
    }

    const email = params.email.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Email inválido.", 400);
    }
    if (this.emailIndex.has(email)) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Este endereço de email já está cadastrado.", 409);
    }

    if (!params.password || params.password.length < 6) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "A senha deve conter no mínimo 6 caracteres.", 400);
    }

    const passwordHash = await hashPassword(params.password);
    const userId = `usr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const requireVerification = this.isEmailVerificationRequired();

    // Default project / policies: empty projects by default so unlinked users stay unlinked cleanly
    const defaultProjects = process.env.BRAIN_ALLOWED_PROJECTS
      ? process.env.BRAIN_ALLOWED_PROJECTS.split(",").map((p) => p.trim()).filter(Boolean)
      : [];
    const defaultPolicies = (process.env.BRAIN_ALLOWED_POLICIES || "public-org,internal-project")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    const user: AuthUser = {
      id: userId,
      tenantId: params.tenantId || "default-org",
      email,
      name: params.name.trim() || email.split("@")[0],
      passwordHash,
      emailVerified: !requireVerification,
      roles: params.roles ?? ["developer"],
      allowedProjects: params.allowedProjects ?? defaultProjects,
      allowedPolicies: params.allowedPolicies ?? defaultPolicies,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.users.set(user.id, user);
    this.emailIndex.set(email, user.id);

    let verificationToken: string | undefined;
    if (requireVerification) {
      verificationToken = this.createVerificationToken(user.id, "email_verification");
    }

    return { user, verificationToken };
  }

  async authenticateUser(email: string, candidatePass: string): Promise<AuthUser> {
    const normalized = email.trim().toLowerCase();
    const userId = this.emailIndex.get(normalized);
    if (!userId) {
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Email ou senha incorretos.", 401);
    }
    const user = this.users.get(userId);
    if (!user) {
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Email ou senha incorretos.", 401);
    }

    const valid = await verifyPassword(user.passwordHash, candidatePass);
    if (!valid) {
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Email ou senha incorretos.", 401);
    }

    if (this.isEmailVerificationRequired() && !user.emailVerified) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Por favor, confirme seu endereço de email antes de efetuar login.", 403);
    }

    return user;
  }

  getUserById(id: string): AuthUser | null {
    return this.users.get(id) ?? null;
  }

  getUserByEmail(email: string): AuthUser | null {
    const id = this.emailIndex.get(email.trim().toLowerCase());
    return id ? (this.users.get(id) ?? null) : null;
  }

  updateUserPermissions(
    userId: string,
    updates: {
      roles?: string[];
      allowedProjects?: string[];
      allowedPolicies?: string[];
      customPermissions?: SystemPermission[];
      emailVerified?: boolean;
    }
  ): AuthUser {
    const user = this.users.get(userId);
    if (!user) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", "Usuário não encontrado.", 404);
    }

    if (updates.roles) user.roles = [...updates.roles];
    if (updates.allowedProjects) user.allowedProjects = [...updates.allowedProjects];
    if (updates.allowedPolicies) user.allowedPolicies = [...updates.allowedPolicies];
    if (updates.customPermissions) user.customPermissions = [...updates.customPermissions];
    if (typeof updates.emailVerified === "boolean") user.emailVerified = updates.emailVerified;
    user.updatedAt = new Date().toISOString();

    return user;
  }

  createVerificationToken(userId: string, type: "email_verification" | "password_reset"): string {
    const token = randomBytes(24).toString("hex");
    this.verificationTokens.set(token, {
      userId,
      token,
      type,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
    });
    return token;
  }

  verifyToken(token: string): AuthUser {
    const entry = this.verificationTokens.get(token);
    if (!entry || Date.now() > entry.expiresAt) {
      if (entry) this.verificationTokens.delete(token);
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Token de verificação inválido ou expirado.", 400);
    }

    const user = this.users.get(entry.userId);
    if (!user) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", "Usuário associado ao token não encontrado.", 404);
    }

    if (entry.type === "email_verification") {
      user.emailVerified = true;
      user.updatedAt = new Date().toISOString();
    }

    this.verificationTokens.delete(token);
    return user;
  }

  listUsers(): AuthUser[] {
    return Array.from(this.users.values());
  }
}

export const usersStore = new UsersStore();

