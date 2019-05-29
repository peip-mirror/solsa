# SolSA

The SolSA library for Node.js makes it possible to specify the architecture of
cloud-native solutions as programs. Using SolSA, a developer can enumerate and
configure all the components of a solution including resources such as managed
cloud services, cloud functions, containerized services, Knative services and
event sources.

SolSA leverages Kubernetes operators to define and configure these resources
whether they run inside or outside of a Kubernetes cluster. SolSA relies on the
[composable operator](https://github.ibm.com/seed/composable) to encode dynamic
dependencies between resource configurations.

SolSA can synthesize all the yaml needed to deploy a solution. But it does not
have to. SolSA makes it easy to share resources across solutions. The generated
yaml can be deployed at once, i.e., with a single `kubectl apply` command.
Optionally, SolSA leverages
[Kustomize](https://github.com/kubernetes-sigs/kustomize) to permit targeting
multiple environments, e.g., local development cluster, IKS or ICP cluster.
SolSA automatically tailors resources such as ingresses to the specifics of each
targeted environment.

SolSA enables the specification of repeatable architectural patterns that can be
reused across many solutions. SolSA supports expressing dependencies on shared
resources. SolSA simplifies the configuration of related resources such as a
Kafka instance, a Kafka topic, and a Knative Kafka event source. The SolSA code
is much more compact than the yaml it produces. The SolSA code is much less
error-prone than the corresponding yaml.

SolSA includes an optional capability to containerize Node.js code. This
facilitates the integration of components that require a little bit of glue code
to interface properly, e.g., to align schemas or match protocols. This glue code
can leverage portable Node.js frameworks such as
[Express](https://expressjs.com) or [KafkaJS](https://kafka.js.org). SolSA
builds and pushes the container image in addition to synthesizing the yaml to
instantiate the image with the proper configuration.

## Components

SolSA consists of:
- A main `solsa` Node.js module that provides a library of high-level
  abstractions for defining the software architecture of a solution.
- A `solsa` command-line interface (CLI):
  - `solsa init` initializes a Kubernetes namespace for SolSA use.
  - `solsa build` builds container images for SolSA-defined services (if any).
  - `solsa push` pushes container images for SolSA-defined services (if any).
  - `solsa yaml` synthesizes yaml for deploying SolSA solutions on Kubernetes.

## Setup

Install SolSA:
```shell
npm -g install git+ssh://git@github.ibm.com:solsa/solsa.git
```

### Kubernetes Cluster Setup

Note: If you are installing SolSA on an IKS cluster, we assume your cluster is
already properly configured to enable you to pull images from the IBM Container
Registry. If it is not, please see the instructions at
https://cloud.ibm.com/docs/containers?topic=containers-images.

We assume that you have already configured `kubectl` to be able to access each
Kubernetes cluster you will be using with SolSA.

1. Install SEED operators from https://github.ibm.com/seed/charts.

2. Install the Composable operator from https://github.ibm.com/seed/composable.

3. Optionally install Knative. For IKS, follow the instructions at
   https://cloud.ibm.com/docs/containers?topic=containers-serverless-apps-knative.

4. Optionally install the Kafka Knative Event Source from
   https://github.com/knative/eventing-sources/tree/master/contrib/kafka/samples.
   If using the IBM container registry make sure to add a corresponding image
   pull secret to the `kafka-controller-manager` service account of the
   `knative-sources` namespace.

### Per Namespace Setup

Run for each namespace which will host SolSA-defined services:
```shell
solsa init my-namespace
```

### Local Configuration File

Optionally create a `.solsa.yaml` file in your home directory that describes
each Kubernetes context for which you want SolSA to generate a Kustomize
overlay. The example file below defines two deployment contexts, a local
development environment provided by Docker Desktop that uses a NodePort ingress
and an IKS cluster.
```yaml
contexts:
- name: 'docker-for-desktop'
  ingress:
    nodePort: 32323
- name: 'mycluster'
  ingress:
    iks:
      subdomain: 'mycluster123.us-east.containers.appdomain.cloud'
      tlssecret: 'mycluster123'
  registry: 'us.icr.io/tardieu'
  images:
  - name: solsa-translator
    newName: us.icr.io/groved/solsa-translator
```
The IKS context definition demonstrates how to instruct SolSA to generate a
Kustomize overlay that will rename docker images so that instead of being pulled
from the local registry on the dev machine, the images will instead be pulled
from a specific namespace in the IBM Container Registry. Rules for specific
images can also be specified using Kustomize syntax.

## Examples

The [solsa-examples](https://github.ibm.com/solsa/solsa-examples) repository
contains sample cloud native applications and architectural patterns defined
using SolSA.

A SolSA application `myApp.js` can be built and deployed to the current
Kubernetes context using the `solsa` CLI and `kubectl` as shown below.
```shell
solsa build myApp.js
solsa push myApp.js
solsa yaml myApp.js | kubectl apply -f -
```
The `build` and `push` steps are not necessary when only using SolSA to
synthesize yaml. These steps tag and push images for SolSA-defined services
according to the SolSA configuration for the current Kubernetes context.

Run `solsa` with no arguments to see a list of supported commands and flags.

To undeploy the application, use the command:
```shell
solsa yaml myApp.js | kubectl delete -f -
```

## Development

To contribute to the development of SolSA, clone and link this repository:
```shell
git clone https://github.ibm.com/solsa/solsa.git
cd solsa
npm install
npm link
```
This will ensure the `solsa` CLI uses the local checkout.
