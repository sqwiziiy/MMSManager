import { serverTemplateListSchema, serverTemplateResultSchema } from '@mmsmanager/shared'
import type { ServerTemplate, ServerTemplateInput } from '@mmsmanager/shared'
import { apiRequest } from './client'

export async function getServerTemplates(signal?: AbortSignal): Promise<ServerTemplate[]> {
  return (await apiRequest('/api/v1/templates', serverTemplateListSchema, { signal })).templates
}

export async function createServerTemplate(input: ServerTemplateInput): Promise<ServerTemplate> {
  return (await apiRequest('/api/v1/admin/templates', serverTemplateResultSchema, { method: 'POST', body: JSON.stringify(input) })).template
}

export async function updateServerTemplate(templateId: string, input: ServerTemplateInput): Promise<ServerTemplate> {
  return (await apiRequest(`/api/v1/admin/templates/${encodeURIComponent(templateId)}`, serverTemplateResultSchema, { method: 'PATCH', body: JSON.stringify(input) })).template
}

export async function duplicateServerTemplate(templateId: string): Promise<ServerTemplate> {
  return (await apiRequest(`/api/v1/admin/templates/${encodeURIComponent(templateId)}/duplicate`, serverTemplateResultSchema, { method: 'POST', body: '{}' })).template
}

export async function deleteServerTemplate(templateId: string): Promise<void> {
  await apiRequest(`/api/v1/admin/templates/${encodeURIComponent(templateId)}`, { parse: (value: unknown) => value }, { method: 'DELETE' })
}
