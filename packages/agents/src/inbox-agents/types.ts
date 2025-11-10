export type Email = {
  id: string;
  thread_id: string;
  history_id: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  reply_to: string;
  date: string;
  body: string;
  snippet: string;
  header_message_id: string;
  in_reply_to: string;
  references: string;
  label_ids: string[];
};

export const EmailCategory = {
  INBOX: "inbox",
  SPAM: "spam",
  TRASH: "trash",
  URGENT: "urgent",
  IMPORTANT: "important",
  MEETING: "meeting",
} as const;

export type EmailCategory = (typeof EmailCategory)[keyof typeof EmailCategory];
