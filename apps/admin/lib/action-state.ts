/** Result of a Server Action, rendered inline next to the form that triggered it. */
export type ActionState =
  | { status: 'idle' }
  | { status: 'ok'; message: string; href?: string; hrefLabel?: string }
  | { status: 'error'; code: string; message: string; details?: string };

export const IDLE: ActionState = { status: 'idle' };

export type ServerAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;
