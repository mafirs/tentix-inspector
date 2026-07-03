import { ListSupportedK8sResourcesInput, ListSupportedK8sResourcesInputSchema } from './types';
import { listSupportedKubectlResources } from './kubectl-resource-registry';

export async function listSupportedK8sResources(
  input: ListSupportedK8sResourcesInput
): Promise<unknown> {
  const { namespace } = ListSupportedK8sResourcesInputSchema.parse(input);
  const resources = listSupportedKubectlResources();
  return {
    namespace,
    resources,
    total: resources.length,
    success: true,
  };
}
