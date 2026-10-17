import { useId } from 'react';

export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <div className="toggle">
      <span id={id}>{label}</span>
      <button className="sw" type="button" role="switch" aria-checked={checked} aria-labelledby={id} onClick={() => onChange(!checked)} />
    </div>
  );
}
