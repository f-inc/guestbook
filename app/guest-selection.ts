export function updateGuestSelection(
  selectedIds: Set<string>,
  orderedIds: string[],
  personId: string,
  selected: boolean,
  anchorId = "",
  range = false,
) {
  const next = new Set(selectedIds);
  const targetIndex = orderedIds.indexOf(personId);
  const anchorIndex = range ? orderedIds.indexOf(anchorId) : -1;
  const ids = targetIndex >= 0 && anchorIndex >= 0
    ? orderedIds.slice(Math.min(targetIndex, anchorIndex), Math.max(targetIndex, anchorIndex) + 1)
    : [personId];

  ids.forEach((id) => {
    if (selected) next.add(id);
    else next.delete(id);
  });
  return next;
}
