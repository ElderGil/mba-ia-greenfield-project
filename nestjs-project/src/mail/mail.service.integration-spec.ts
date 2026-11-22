import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import appConfig from '../config/app.config';
import mailConfig from '../config/mail.config';
import { randomUUID } from 'node:crypto';
import { getMailpitMessage, getMailpitMessagesTo } from '../test/mailpit';
import { MAIL_SUBJECTS } from './mail.constants';
import { MailModule } from './mail.module';
import { MailService } from './mail.service';

describe('MailService (integration)', () => {
  let mailService: MailService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [appConfig, mailConfig] }),
        MailModule,
      ],
    }).compile();

    mailService = module.get(MailService);
  });

  // Mailpit is shared with the running stack: each test gets its own
  // recipient and reads only its messages.
  let recipient: string;
  beforeEach(() => {
    recipient = `mail_${randomUUID()}@example.com`;
  });

  it('sendConfirmationEmail delivers to Mailpit with correct subject and recipient', async () => {
    await mailService.sendConfirmationEmail(recipient, 'Alice', 'token123');

    const messages = await getMailpitMessagesTo(recipient);
    expect(messages).toHaveLength(1);
    expect(messages[0].To[0].Address).toBe(recipient);
    expect(messages[0].Subject).toBe(MAIL_SUBJECTS.CONFIRMATION);
  });

  it('sendConfirmationEmail renders the confirmation URL in the body', async () => {
    await mailService.sendConfirmationEmail(recipient, 'Alice', 'mytoken');

    const messages = await getMailpitMessagesTo(recipient);
    const detail = await getMailpitMessage(messages[0].ID);

    expect(detail.HTML).toContain('mytoken');
    expect(detail.HTML).toContain('Alice');
    expect(detail.HTML).toContain('confirm-email');
  });

  it('sendPasswordResetEmail delivers to Mailpit with correct subject and recipient', async () => {
    await mailService.sendPasswordResetEmail(recipient, 'Bob', 'resettoken');

    const messages = await getMailpitMessagesTo(recipient);
    expect(messages).toHaveLength(1);
    expect(messages[0].To[0].Address).toBe(recipient);
    expect(messages[0].Subject).toBe(MAIL_SUBJECTS.PASSWORD_RESET);
  });

  it('sendPasswordResetEmail renders the reset URL and expiry notice in the body', async () => {
    await mailService.sendPasswordResetEmail(recipient, 'Bob', 'resettoken');

    const messages = await getMailpitMessagesTo(recipient);
    const detail = await getMailpitMessage(messages[0].ID);

    expect(detail.HTML).toContain('resettoken');
    expect(detail.HTML).toContain('Bob');
    expect(detail.HTML).toContain('reset-password');
    expect(detail.HTML).toContain('1 hour');
  });

  it('both emails use the configured MAIL_FROM address as sender', async () => {
    await mailService.sendConfirmationEmail(recipient, 'Alice', 'tok');

    const messages = await getMailpitMessagesTo(recipient);
    const configuredFrom =
      process.env.MAIL_FROM ?? '"StreamTube" <noreply@streamtube.com>';
    const expectedAddress =
      configuredFrom.match(/<(.+)>/)?.[1] ?? configuredFrom;
    expect(messages[0].From.Address).toBe(expectedAddress);
  });
});
