import type { InputHTMLAttributes } from 'react';

/** A text input. Give it `aria-label` or `aria-labelledby`. */
export function Field({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" className={['field', className].filter(Boolean).join(' ')} {...rest} />;
}
