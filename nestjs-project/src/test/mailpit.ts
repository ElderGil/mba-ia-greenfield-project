const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

export interface MailpitAddress {
  Name: string;
  Address: string;
}

export interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  From: MailpitAddress;
  To: MailpitAddress[];
}

export interface MailpitMessage extends MailpitMessageSummary {
  HTML: string;
  Text: string;
}

// Mailpit is shared with the running stack: tests send to their own unique
// address and read only its messages, never the whole mailbox.
export async function getMailpitMessagesTo(
  address: string,
): Promise<MailpitMessageSummary[]> {
  const query = encodeURIComponent(`to:"${address}"`);
  const res = await fetch(`${mailpitUrl}/api/v1/search?query=${query}`);
  const data = (await res.json()) as { messages?: MailpitMessageSummary[] };
  return data.messages ?? [];
}

export async function getMailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return (await res.json()) as MailpitMessage;
}
