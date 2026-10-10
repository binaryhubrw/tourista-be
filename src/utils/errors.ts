export interface FieldError {
  path: string;
  message: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public errors?: FieldError[]) {
    super(message);
  }
}

export const badRequest = (m: string, errors?: FieldError[]) => new HttpError(400, m, errors);
export const unauthorized = (m = 'Log in to continue.') => new HttpError(401, m);
export const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, m);
export const notFound = (what: string) => new HttpError(404, `${what} was not found.`);
export const conflict = (m: string) => new HttpError(409, m);
export const unprocessable = (m: string) => new HttpError(422, m);
