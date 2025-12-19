# Variable: Form()

```ts
const Form: <TFieldValues, TContext, TTransformedValues>(props) => Element = FormProvider;
```

Defined in: [packages/appkit-ui/src/react/ui/form.tsx:19](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/ui/form.tsx#L19)

A provider component that propagates the `useForm` methods to all children components via [React Context](https://react.dev/reference/react/useContext) API. To be used with useFormContext.

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `TFieldValues` *extends* `FieldValues` | - |
| `TContext` | `any` |
| `TTransformedValues` | `TFieldValues` |

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `props` | `FormProviderProps`\<`TFieldValues`, `TContext`, `TTransformedValues`\> | all useForm methods |

## Returns

`Element`

## Remarks

[API](https://react-hook-form.com/docs/useformcontext) • [Demo](https://codesandbox.io/s/react-hook-form-v7-form-context-ytudi)

## Example

```tsx
function App() {
  const methods = useForm();
  const onSubmit = data => console.log(data);

  return (
    <FormProvider {...methods} >
      <form onSubmit={methods.handleSubmit(onSubmit)}>
        <NestedInput />
        <input type="submit" />
      </form>
    </FormProvider>
  );
}

 function NestedInput() {
  const { register } = useFormContext(); // retrieve all hook methods
  return <input {...register("test")} />;
}
```
