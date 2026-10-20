import { z } from 'zod'

// Shape only; content rules (URL, lengths) are checked by validateEndpointInput.
export const EndpointBodySchema = z.object({
  purpose: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  model: z.string(),
  apiKey: z.string().optional(),
  clearApiKey: z.boolean().optional(),
})

export async function parseEndpointBody(request: Request) {
  try {
    const parsed = EndpointBodySchema.safeParse(await request.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
