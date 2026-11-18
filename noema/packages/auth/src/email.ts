import nodemailer, { type Transporter } from "nodemailer";

export interface SmtpConfig {
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  from?: string;
  secure?: boolean;
}

export interface SendEmailResult {
  success: boolean;
  messageId: string;
  simulated: boolean;
  previewUrl?: string;
}

export function getSmtpConfigFromEnv(): SmtpConfig {
  return {
    host: process.env.SMTP_HOST || process.env.NOEMA_SMTP_HOST,
    port: Number(process.env.SMTP_PORT || process.env.NOEMA_SMTP_PORT || "587"),
    user: process.env.SMTP_USER || process.env.NOEMA_SMTP_USER,
    pass: process.env.SMTP_PASS || process.env.NOEMA_SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.NOEMA_SMTP_FROM || "no-reply@noema.local",
    secure: (process.env.SMTP_SECURE || process.env.NOEMA_SMTP_SECURE) === "true"
  };
}

export class EmailService {
  private transporter: Transporter | null = null;
  private config: SmtpConfig;

  constructor(config: SmtpConfig = getSmtpConfigFromEnv()) {
    this.config = config;
    if (config.host && config.host.trim().length > 0) {
      this.transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure ?? false,
        auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined
      });
    }
  }

  isConfigured(): boolean {
    return Boolean(this.transporter && this.config.host);
  }

  async sendVerificationEmail(params: {
    to: string;
    name: string;
    verificationToken: string;
    appUrl?: string;
  }): Promise<SendEmailResult> {
    const { to, name, verificationToken, appUrl = "http://localhost:3000" } = params;
    const verifyUrl = `${appUrl}/auth/verify?token=${encodeURIComponent(verificationToken)}`;

    const subject = "Noema — Confirme seu endereço de email";
    const text = `Olá, ${name}!\n\nObrigado por se registrar no Noema (Project Brain OS).\nPara confirmar seu email e ativar sua conta com suas permissões personalizadas, acesse o link abaixo:\n\n${verifyUrl}\n\nCódigo do token: ${verificationToken}\n\nSe você não solicitou este cadastro, por favor ignore este email.`;

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #07090f; color: #eef1f6; border-radius: 12px; border: 1px solid rgba(148,163,184,0.18);">
        <div style="margin-bottom: 20px;">
          <h2 style="margin: 0; color: #818cf8; font-size: 20px; font-weight: 700;">Noema Brain OS</h2>
          <p style="margin: 4px 0 0; color: #94a3b8; font-size: 13px;">Confirmação de Registro de Usuário</p>
        </div>
        <p style="font-size: 14px; line-height: 1.5; color: #cbd5e1;">Olá, <strong>${name}</strong>,</p>
        <p style="font-size: 14px; line-height: 1.5; color: #cbd5e1;">
          Sua conta foi criada no Noema com perfil de acesso e políticas do projeto. Clique no botão abaixo para validar seu email:
        </p>
        <div style="margin: 24px 0; text-align: center;">
          <a href="${verifyUrl}" style="background: #6366f1; color: #ffffff; text-decoration: none; padding: 10px 22px; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block;">
            Confirmar meu Email
          </a>
        </div>
        <div style="background: rgba(148, 163, 184, 0.08); border-radius: 8px; padding: 12px; margin-top: 20px; font-size: 12px; color: #94a3b8;">
          <strong>Token de Ativação:</strong> <code style="color: #cbd5e1; font-family: monospace;">${verificationToken}</code>
        </div>
        <p style="font-size: 11px; color: #64748b; margin-top: 24px; border-top: 1px solid rgba(148,163,184,0.12); padding-top: 12px;">
          Se você não solicitou este registro, nenhuma ação é necessária.
        </p>
      </div>
    `;

    if (this.transporter) {
      try {
        const info = await this.transporter.sendMail({
          from: this.config.from,
          to,
          subject,
          text,
          html
        });
        return { success: true, messageId: info.messageId, simulated: false };
      } catch (error) {
        console.error("[EmailService] Erro ao enviar email via SMTP:", error);
      }
    }

    // Simulated transport (useful in development/tests or when SMTP is not configured)
    return {
      success: true,
      messageId: `simulated-${Date.now()}`,
      simulated: true,
      previewUrl: verifyUrl
    };
  }

  async sendOAuthAlert(params: {
    to: string;
    name: string;
    clientName: string;
    userAgent?: string;
  }): Promise<SendEmailResult> {
    const { to, name, clientName, userAgent } = params;
    const subject = `Noema — Novo Agente/Plugin conectado: ${clientName}`;
    const text = `Olá, ${name}!\n\nUm novo agente ou integração (${clientName}) foi autenticado na sua conta Noema via OAuth2.\n\nDetalhes: ${userAgent ?? "Cliente MCP / Plugin"}\n\nSe você não reconhece esta atividade, acesse o painel de Acesso & Políticas imediatamente para revogar os tokens.`;

    if (this.transporter) {
      try {
        const info = await this.transporter.sendMail({
          from: this.config.from,
          to,
          subject,
          text
        });
        return { success: true, messageId: info.messageId, simulated: false };
      } catch (error) {
        console.error("[EmailService] Erro ao enviar alerta OAuth:", error);
      }
    }

    return {
      success: true,
      messageId: `simulated-oauth-${Date.now()}`,
      simulated: true
    };
  }
}
