/**
 * The halt alert (integration plan §10, built 2026-07-30): when a daily
 * artefact lands carrying a halted reconciliation, a plain message goes
 * to the account's alert topic, the same channel the budget kill-chain
 * already writes to and the owner already subscribes to. Best-effort by
 * design: the artefact store must never fail because the alert could
 * not send; the app's loud banner is the control, the email is the
 * nudge that says open it.
 */
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';

export interface HaltAlerter {
  publishHalt(subject: string, message: string): Promise<void>;
}

export class SnsHaltAlerter implements HaltAlerter {
  constructor(
    private readonly sns: SNSClient,
    private readonly topicArn: string
  ) {}

  static fromEnv(): SnsHaltAlerter | undefined {
    const topicArn = process.env['ALERT_TOPIC_ARN'];
    if (topicArn === undefined || topicArn === '') return undefined;
    return new SnsHaltAlerter(new SNSClient({}), topicArn);
  }

  async publishHalt(subject: string, message: string): Promise<void> {
    await this.sns.send(
      new PublishCommand({ TopicArn: this.topicArn, Subject: subject, Message: message })
    );
  }
}
