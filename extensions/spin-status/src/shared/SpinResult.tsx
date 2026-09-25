import { useEffect, useRef, useState } from "preact/hooks";
import { SHOP_ORIGIN, discountShopUrl, rewardShortLabel } from "../../../../app/config/campaign";
import type { PublicSpinResult } from "./api";
import { formatExpiryShort } from "./format";

const CLIPBOARD_ID = "greentee-spin-code";
const COPIED_MS = 2000;

export interface SpinResultProps {
  readonly result: PublicSpinResult;
  readonly testMode: boolean;
  /** Thank you page celebrates the win; order status page just presents the reward. */
  readonly surface: "thank-you" | "order-status";
  /** Thank you page only: where to finish a pending gift. Never rendered on the order status page. */
  readonly spinUrl?: string | null;
}

/**
 * The stored reward, laid out like the storefront modal's result card:
 * heading, code row with a copy control, a full-width shop button, then two
 * small meta lines. Shared by both targets so the two pages never disagree
 * about what a customer won.
 */
export function SpinResult({ result, testMode, surface, spinUrl }: SpinResultProps) {
  const short = rewardShortLabel(result.rewardKey) || result.rewardLabel;
  const expiry = formatExpiryShort(result.expiresAt);
  const heading =
    surface === "thank-you" ? `You won ${short}!` : `Your Spin to Win reward: ${short}`;

  if (result.rewardType === "gift") {
    const status = result.gift?.status ?? "pending";
    if (status === "added") {
      const what = result.gift?.variantTitle
        ? `${result.rewardLabel} (${result.gift.variantTitle})`
        : result.rewardLabel;
      return (
        <Card heading={heading} testMode={testMode}>
          <s-button variant="primary" inlineSize="fill" href={`${SHOP_ORIGIN}/`}>
            Start shopping
          </s-button>
          <Meta lines={[`Added to this order at no charge: ${what}.`]} />
        </Card>
      );
    }
    if (status === "unavailable") {
      return (
        <Card heading={heading} testMode={testMode}>
          <Meta
            lines={[
              "That gift was out of stock when you tried to add it. Contact us and we'll sort it out.",
            ]}
          />
        </Card>
      );
    }
    // Pending. Only the Thank you page may send the customer to the spin page.
    if (surface === "thank-you" && spinUrl) {
      return (
        <Card heading={heading} testMode={testMode}>
          <s-button variant="primary" inlineSize="fill" href={spinUrl}>
            Add my gift
          </s-button>
          <Meta lines={["Confirm your gift and we'll add it to this order at no charge."]} />
        </Card>
      );
    }
    return (
      <Card heading={heading} testMode={testMode}>
        <Meta
          lines={[
            "Your gift hasn't been added to this order yet. Contact us and we'll sort it out.",
          ]}
        />
      </Card>
    );
  }

  const code = result.code ?? "";

  if (result.expired) {
    return (
      <Card heading="Your Spin to Win code has expired" testMode={testMode}>
        <CodeRow code={code} />
        <Meta lines={[`${short} · Expired ${expiry}`]} />
      </Card>
    );
  }

  return (
    <Card heading={heading} testMode={testMode}>
      <CodeRow code={code} />
      <s-button variant="primary" inlineSize="fill" href={discountShopUrl(result.rewardKey, code)}>
        Shop with discount
      </s-button>
      <Meta
        lines={
          surface === "thank-you"
            ? [`Valid until ${expiry} · One-time use`, "Also on your order status page."]
            : [`Valid until ${expiry} · One-time use`]
        }
      />
    </Card>
  );
}

/** Neutral bordered container; the heading carries the test badge when it applies. */
function Card({
  heading,
  testMode,
  children,
}: {
  readonly heading: string;
  readonly testMode: boolean;
  readonly children: preact.ComponentChildren;
}) {
  return (
    <s-box border="base" borderRadius="base" padding="large" background="base">
      <s-stack direction="block" gap="base" alignItems="center">
        <s-stack direction="inline" gap="small" alignItems="center" justifyContent="center">
          <s-heading>{heading}</s-heading>
          {testMode ? <TestBadge /> : null}
        </s-stack>
        {children}
      </s-stack>
    </s-box>
  );
}

/**
 * The code in a dashed box with the copy control inside the same row. Copying
 * goes through s-clipboard-item, the only clipboard access checkout allows;
 * its copy event drives the two second "Copied" confirmation.
 */
function CodeRow({ code }: { readonly code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onCopy = () => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <s-grid
      gridTemplateColumns="1fr auto"
      gap="small"
      alignItems="center"
      inlineSize="100%"
      border="base base dashed"
      borderRadius="base"
      paddingBlock="small"
      paddingInline="base"
    >
      <s-heading>{code}</s-heading>
      <s-button
        variant="secondary"
        accessibilityLabel={copied ? "Code copied" : "Copy discount code"}
        command="--copy"
        commandFor={CLIPBOARD_ID}
      >
        {copied ? (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-icon type="check" />
            Copied
          </s-stack>
        ) : (
          <s-icon type="clipboard" />
        )}
      </s-button>
      <s-clipboard-item id={CLIPBOARD_ID} text={code} onCopy={onCopy}></s-clipboard-item>
    </s-grid>
  );
}

/** Small subdued lines under the button. Two at most. */
function Meta({ lines }: { readonly lines: readonly string[] }) {
  return (
    <s-stack direction="block" gap="none" alignItems="center">
      {lines.slice(0, 2).map((line) => (
        <s-text key={line} type="small" color="subdued">
          {line}
        </s-text>
      ))}
    </s-stack>
  );
}

export function TestBadge() {
  return (
    <s-badge size="small" color="subdued">
      Test spin
    </s-badge>
  );
}
