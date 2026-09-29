declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string
        organizationId: string
        organizationRole?: string
      }
    }
  }
}

export {}
