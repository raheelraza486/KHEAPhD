/** Retire persisted-draft routes without deleting previously stored records. */
export function retiredDraftResponse() {
  return Response.json({ error: 'Saved drafts are no longer available. Open Discovery or Create a workflow to start a temporary session.' },
    { status: 410, headers: { 'Cache-Control': 'private, no-store' } });
}
