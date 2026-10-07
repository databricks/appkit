# Interface: DecideResponse\<Q\>

## Type Parameters

| Type Parameter | Default type |
| ------ | ------ |
| `Q` *extends* `DecideQuestions` | `DecideQuestions` |

## Properties

### metadata?

```ts
optional metadata: DecideMetadata;
```

***

### response?

```ts
optional response: {
  answers: DecideAnswers<Q>;
};
```

#### answers

```ts
answers: DecideAnswers<Q>;
```
