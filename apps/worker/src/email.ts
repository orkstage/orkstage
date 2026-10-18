// SPDX-License-Identifier: AGPL-3.0-only
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { PlatformConfig } from '@orkstage/runtime';
import nodemailer from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Where notification, invitation and status emails go out (open item 16). */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * SMTP (any server, Mailpit in development) or Amazon SES v2. SES uses the worker's own AWS
 * credentials and `AWS_REGION`, never a cloud target's role: email is platform infrastructure.
 */
export function emailSender(config: PlatformConfig): EmailSender {
  if (config.EMAIL_TRANSPORT === 'ses') {
    const ses = new SESv2Client({});
    return {
      async send(m) {
        await ses.send(
          new SendEmailCommand({
            FromEmailAddress: config.EMAIL_FROM,
            Destination: { ToAddresses: [m.to] },
            Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Text: { Data: m.text, Charset: 'UTF-8' } } } },
          }),
        );
      },
    };
  }
  const smtp = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD ?? '' } } : {}),
  });
  return {
    async send(m) {
      await smtp.sendMail({ from: config.EMAIL_FROM, ...m });
    },
  };
}
