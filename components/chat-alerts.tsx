import Link from "next/link";
import { addChatChannel, addDeskChatChannel, changeChatChannel } from "@/actions/chat-alerts";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import {
  buyerChannels,
  CHAT_BUYER_EVENTS,
  CHAT_KIND_LABELS,
  CHAT_KINDS,
  channelEventsText,
  chatProProblem,
  DESK_CHAT_POWERS,
  deskChannels,
  MAX_BUYER_CHANNELS,
  PAUSE_AFTER,
  type ChannelView,
} from "@/lib/chat-alerts";
import { canManageSeats, type ActingUser } from "@/lib/seats";

// Minutes matter for a failed send, so times show in UTC to the minute, as the Buyer API page's log does.
const stamp = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

function kindLabel(kind: string) {
  return CHAT_KIND_LABELS[kind === "TEAMS" ? "TEAMS" : "SLACK"];
}

function ChannelCard({ channel, desk, manage, canTest }: { channel: ChannelView; desk: boolean; manage: boolean; canTest: boolean }) {
  const paused = Boolean(channel.pausedAt);
  return (
    <li className="rounded-xl border border-border p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 break-words font-medium text-foreground">
          {kindLabel(channel.kind)}
          {channel.label ? ` · ${channel.label}` : ""}
        </p>
        {paused && <span className="text-[13px] font-medium text-warn">Paused</span>}
      </div>
      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{channel.urlHint}</p>
      <p className="mt-2 break-words text-xs text-muted-foreground">Sends: {channelEventsText(channel, desk)}</p>
      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
        {channel.lastSentAt ? `Last sent ${stamp(channel.lastSentAt)}` : "Nothing sent yet."}
        {channel.pausedAt ? ` · Paused ${stamp(channel.pausedAt)}${channel.failures >= PAUSE_AFTER ? ` after ${PAUSE_AFTER} failed sends in a row` : ""}` : ""}
      </p>
      {channel.lastError && <p className="mt-1 break-words text-xs text-bad">Last error: {channel.lastError}</p>}
      {manage && (
        <div className="mt-3 flex flex-wrap gap-2">
          {canTest && (
            <form action={changeChatChannel}>
              <input type="hidden" name="id" value={channel.id} />
              <input type="hidden" name="intent" value="test" />
              <SubmitButton variant="outline" pendingLabel="Sending…" className="h-10 px-4 text-[13px] font-medium">Send a test</SubmitButton>
            </form>
          )}
          <form action={changeChatChannel}>
            <input type="hidden" name="id" value={channel.id} />
            <input type="hidden" name="intent" value={paused ? "resume" : "pause"} />
            <SubmitButton variant="outline" pendingLabel="Saving…" className="h-10 px-4 text-[13px] font-medium">{paused ? "Resume" : "Pause"}</SubmitButton>
          </form>
          <form action={changeChatChannel}>
            <input type="hidden" name="id" value={channel.id} />
            <input type="hidden" name="intent" value="remove" />
            <SubmitButton variant="ghost" pendingLabel="Removing…" className="h-10 px-4 text-[13px] font-medium">Remove</SubmitButton>
          </form>
        </div>
      )}
    </li>
  );
}

function AddChannelForm({ desk }: { desk: boolean }) {
  const choices = desk ? DESK_CHAT_POWERS : CHAT_BUYER_EVENTS;
  return (
    <form action={desk ? addDeskChatChannel : addChatChannel} className="space-y-4 border-t border-border pt-4">
      <p className="text-[13px] font-medium text-foreground">Add a channel</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">App</span>
          <select name="kind" defaultValue="SLACK" className="desk-input mt-2" aria-label="Chat app">
            {CHAT_KINDS.map((kind) => (
              <option key={kind} value={kind}>{CHAT_KIND_LABELS[kind]}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Name on this page (optional)</span>
          <input name="label" maxLength={60} placeholder={desk ? "#desk-alerts" : "#note-desk"} className="desk-input mt-2" />
        </label>
      </div>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Webhook address</span>
        <input name="url" type="url" inputMode="url" required autoComplete="off" spellCheck={false} maxLength={600} placeholder="https://hooks.slack.com/services/…" className="desk-input mt-2 font-mono" />
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          In Slack, add an incoming webhook to the channel. In Teams, use the Workflows template &ldquo;Post to a channel when a webhook request is received&rdquo;. The address works like a password: once saved, this page shows only its host and last four characters.
        </span>
      </label>
      <fieldset>
        <legend className="text-[13px] text-muted-foreground">{desk ? "Notices that name a power go when it is ticked" : "Alerts to send"}</legend>
        <div className="mt-1 grid sm:grid-cols-2 sm:gap-x-4">
          {choices.map((item) => (
            <label key={item.event} className="flex min-h-10 items-start gap-3 py-2 text-sm text-foreground">
              <input type="checkbox" name="events" value={item.event} defaultChecked className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">{item.label}</span>
            </label>
          ))}
        </div>
        {desk && <p className="mt-1 text-xs text-muted-foreground">Notices every desk member gets always go.</p>}
      </fieldset>
      <SubmitButton pendingLabel="Adding…" className="h-11 w-full text-[13px] font-medium sm:w-auto">Add channel</SubmitButton>
    </form>
  );
}

// On the notice settings page, for buyers. The firm's channels: any seat reads them, and the owner or a managing seat
// changes them, as with the firm's webhooks.
export async function BuyerChatAlerts({ user, notice, error }: { user: ActingUser; notice?: string; error?: string }) {
  const channels = await buyerChannels(user.id);
  const pro = chatProProblem(user);
  const manage = canManageSeats(user);
  return (
    <section id="chat" aria-labelledby="chat-heading" className="glass mt-6 scroll-mt-6 space-y-4 p-6">
      <h2 id="chat-heading" className="text-[15px] font-semibold tracking-tight text-foreground">Chat alerts</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Short alerts in a Slack or Microsoft Teams channel your firm reads: buy-box matches, new prices and bid deadlines on saved listings, changes to your bids, and price alerts. Each says what happened and links into UPB, as the email does. Anyone in the channel can read it, so it never carries a borrower, a street or a bid amount.
      </p>
      <Notice notice={notice} error={error} />
      {pro && (
        <p className="text-sm text-muted-foreground">
          {pro}{channels.length ? " The channels below are quiet until Pro is back." : ""}
          {user.accountStatus === "APPROVED" && (
            <>
              {" "}
              <Link href="/buyer/subscription" className="font-medium text-link">See Pro</Link>
            </>
          )}
        </p>
      )}
      {!manage && <p className="text-sm text-muted-foreground">Only a managing seat or the account owner can change chat alerts.</p>}
      {channels.length === 0 ? (
        <p className="text-sm text-muted-foreground">No chat channels yet.</p>
      ) : (
        <ul className="space-y-3">
          {channels.map((channel) => (
            <ChannelCard key={channel.id} channel={channel} desk={false} manage={manage} canTest={!pro} />
          ))}
        </ul>
      )}
      {manage && !pro && (channels.length < MAX_BUYER_CHANNELS ? <AddChannelForm desk={false} /> : <p className="text-sm text-muted-foreground">An account keeps up to {MAX_BUYER_CHANNELS} chat channels. Remove one to add another.</p>)}
    </section>
  );
}

// On the desk settings page, for owners. One channel for the desk's own notices.
export async function DeskChatPanel({ notice, error }: { notice?: string; error?: string }) {
  const channels = await deskChannels();
  return (
    <section id="desk-chat" aria-labelledby="desk-chat-heading" className="mt-8 scroll-mt-6 space-y-4 glass p-6">
      <div>
        <p id="desk-chat-heading" className="eyebrow">Desk chat channel</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          One Slack or Microsoft Teams channel that hears the desk&apos;s notices as they go out by email. Each alert is the notice&apos;s name, such as &ldquo;Claim to review&rdquo;, and a link to the page, never a name, an address or an amount. After {PAUSE_AFTER} failed sends in a row the channel pauses and the owners hear.
        </p>
      </div>
      <Notice notice={notice} error={error} />
      {channels.length > 0 && (
        <ul className="space-y-3">
          {channels.map((channel) => (
            <ChannelCard key={channel.id} channel={channel} desk manage canTest />
          ))}
        </ul>
      )}
      {channels.length === 0 && <AddChannelForm desk />}
    </section>
  );
}
