/**
 * customer-account.order-status.block.render: display only.
 *
 * If this order has a stored spin result, show it with its expiry and a copy
 * control. Otherwise render nothing at all: no eligibility banner, no spin
 * button, no link to the spin page, no "you missed it" message. A spin can
 * only ever start from the Thank you page. That is an invariant.
 */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { SpinResult } from "./shared/SpinResult";
import { appUrlFromSettings, useSpinStatus } from "./shared/useSpinStatus";

declare const shopify: import("@shopify/ui-extensions/customer-account.order-status.block.render").Api;

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const orderId = shopify.order.value?.id ?? null;
  const appUrl = appUrlFromSettings(shopify.settings.value as Record<string, unknown> | undefined);
  const { state } = useSpinStatus({
    orderId,
    appUrl,
    getSessionToken: () => shopify.sessionToken.get(),
  });

  if (state.kind !== "spun") return null;
  return <SpinResult result={state.result} testMode={state.testMode} surface="order-status" />;
}
