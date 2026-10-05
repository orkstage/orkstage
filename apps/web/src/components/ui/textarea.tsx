import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { controlClass } from './input';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(controlClass, 'min-h-20 py-1.5', className)} {...props} />;
}
