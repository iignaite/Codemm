/** Said once a field is full, so a long paste isn't cut short without a word. */
export function Limit({ value, max }: { value: string; max: number }) {
  return value.length >= max ? <p className="quiet-text" role="status">Up to {max.toLocaleString('en-US')} characters.</p> : null;
}
