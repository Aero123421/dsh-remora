/**
 * Official DSH UI primitives, compiled from the pinned DSH source by
 * scripts/build.mjs (see scripts/upstream.mjs). Only the props Remora uses
 * are declared here.
 */
declare module 'remora-official-primitives' {
  import type { ButtonHTMLAttributes, ForwardRefExoticComponent, InputHTMLAttributes, ReactNode, ReactElement, RefAttributes } from 'react'

  export const Button: ForwardRefExoticComponent<{
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement> & RefAttributes<HTMLButtonElement>>

  export function Switch(props: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; title?: string | undefined; className?: string | undefined }): ReactElement

  export const Input: ForwardRefExoticComponent<{ icon?: ReactNode; className?: string } & InputHTMLAttributes<HTMLInputElement> & RefAttributes<HTMLInputElement>>

  export function Modal(props: {
    open: boolean
    onClose: () => void
    title: string
    closeLabel: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    className?: string
  }): ReactElement | null

  export interface SegmentedControlOption<Value extends string> { value: Value; label: string; disabled?: boolean; title?: string }
  export function SegmentedControl<Value extends string>(props: {
    id: string
    value: Value
    options: readonly SegmentedControlOption<Value>[]
    onChange: (next: Value) => void
    label: string
    disabled?: boolean
    className?: string | undefined
  }): ReactElement

  export function Tag(props: { tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'; className?: string | undefined; children?: ReactNode }): ReactElement

  export function StateDot(props: { state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'; size?: number | undefined; className?: string | undefined }): ReactElement
}
