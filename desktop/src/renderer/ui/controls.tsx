import type { ButtonHTMLAttributes, InputHTMLAttributes, Ref } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: 'primary' | 'ghost' | 'text';
  size?: 'lg';
};

export function Button({ kind = 'primary', size, className = '', type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`btn ${kind} ${size ?? ''} ${className}`.trim()} {...rest} />;
}

export function Field({ className = '', ref, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input type="text" ref={ref} className={`field ${className}`.trim()} {...rest} />;
}

export function Chip({ pressed, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean }) {
  return <button type="button" className="chip" aria-pressed={pressed} {...rest} />;
}

export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="toggle">
      <span aria-hidden="true">{label}</span>
      <button type="button" className="sw" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />
    </div>
  );
}
