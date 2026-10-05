// An empty filtered page does not tell us whether the event was ever loaded.
export async function guestIndexIsReady(
  hasVisibleGuests: boolean,
  inspect: () => Promise<{ hasAnyGuests: boolean; sync: { lastGuestSyncAt: unknown; lastStatus: string | null; truncated: boolean; lastGuestCount: number } | null }>,
) {
  if (hasVisibleGuests) return true;
  const { hasAnyGuests, sync } = await inspect();
  return hasAnyGuests || Boolean(sync?.lastGuestSyncAt && sync.lastStatus === "success" && !sync.truncated && sync.lastGuestCount === 0);
}
