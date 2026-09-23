import type { PublicSpinResult } from "./api";
import { formatExpiry } from "./format";

const CLIPBOARD_ID = "greentee-spin-code";

export interface SpinResultProps {
  readonly result: PublicSpinResult;
  readonly testMode: boolean;
  /** Thank you page celebrates the win; order status page just presents the reward. */
  readonly surface: "thank-you" | "order-status";
}

/**
 * The stored reward. Shared by both targets so the two pages never disagree
 * about what a customer won. No email language anywhere: the code lives on
 * screen and on this order's status page only.
 */
export function SpinResult({ result, testMode, surface }: SpinResultProps) {
  const expiry = formatExpiry(result.expiresAt);
  const heading =
    surface === "thank-you"
      ? `You won ${result.rewardLabel}!`
      : `Your Spin to Win reward: ${result.rewardLabel}`;

  if (result.rewardType === "gift") {
    return (
      <s-banner tone="success" heading={heading}>
        <s-stack direction="block" gap="small">
          <s-paragraph>
            We've added it to this order at no charge. It ships with the rest of your items.
          </s-paragraph>
          {testMode ? <TestBadge /> : null}
        </s-stack>
      </s-banner>
    );
  }

  const code = result.code ?? "";

  if (result.expired) {
    return (
      <s-banner tone="warning" heading="Your Spin to Win code has expired">
        <s-stack direction="block" gap="small">
          <s-paragraph>
            Code <s-text type="strong">{code}</s-text> for {result.rewardLabel} expired on {expiry}.
          </s-paragraph>
          {testMode ? <TestBadge /> : null}
        </s-stack>
      </s-banner>
    );
  }

  return (
    <s-banner tone="success" heading={heading}>
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Use this code on your next GreenTee order. One use, and it's yours only.
        </s-paragraph>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-heading>{code}</s-heading>
          <s-button variant="secondary" command="--copy" commandFor={CLIPBOARD_ID}>
            Copy code
          </s-button>
          <s-clipboard-item id={CLIPBOARD_ID} text={code}></s-clipboard-item>
        </s-stack>
        <s-paragraph color="subdued">Valid until {expiry}.</s-paragraph>
        <s-paragraph color="subdued">
          Keep this code somewhere safe. You can also find it later through the link in your order
          confirmation email.
        </s-paragraph>
        {testMode ? <TestBadge /> : null}
      </s-stack>
    </s-banner>
  );
}

export function TestBadge() {
  return <s-badge tone="neutral">Test spin</s-badge>;
}
