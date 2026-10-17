import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'text';
  size?: 'lg';
};

export function Button({ variant = 'primary', size, className, type = 'button', ...rest }: Props) {
  const cls = ['btn', variant, size, className].filter(Boolean).join(' ');
  return <button type={type} className={cls} {...rest} />;
}
